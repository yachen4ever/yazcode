import { ipcRenderer } from "electron";
import {
  USERSCRIPT_IPC_CHANNELS,
  type UserScriptMatchItem,
  type UserScriptMatchResponse,
  type UserScriptStorageGetRequest,
  type UserScriptStorageResult,
  type UserScriptStorageSetRequest,
} from "../main/userscripts/userscriptIpcContract.js";
import { isInjectableUrlProtocol, normalizeRunAt } from "../main/userscripts/userscriptRules.js";

/**
 * IAB 用户脚本 runtime（session 级 preload，隔离世界内运行）：
 * - 每个 frame（主/子）在 document_start 各注入一个实例；页面主世界摸不到本模块的任何符号，
 *   GM_* 以脚本函数参数注入而非 window 全局，runtime 也拿不到页面 JS 变量（仅共享 DOM）；
 * - 非 http(s) scheme（chrome-error、about:blank 等）直接 no-op；
 * - 脚本内容一律经 match IPC 从 main 拉取（enabled ∧ sha256 一致的脚本），
 *   preload 本体不含任何用户脚本；GM 存储仅主 frame 可用（main 以 senderFrame 复核）。
 * electron-free 的判定逻辑与 main 共用同一模块（userscriptRules/userscriptIpcContract）。
 */

const RUNTIME_INSTALLED_FLAG = "__yazcodeIabUserscriptRuntimeInstalled__";

function onceEvent(target: EventTarget, type: string): Promise<void> {
  return new Promise((resolve) => {
    target.addEventListener(type, () => resolve(), { once: true });
  });
}

function waitForRunAt(runAt: string): Promise<void> {
  if (runAt === "document-start") return Promise.resolve();
  if (runAt === "document-end") {
    return document.readyState === "loading"
      ? onceEvent(document, "DOMContentLoaded")
      : Promise.resolve();
  }
  // document-idle：等 load 事件（已过则立即）。
  return document.readyState === "complete" ? Promise.resolve() : onceEvent(window, "load");
}

/** document_start 时 <html>/<head> 可能尚未创建：观察到根节点出现即挂载。 */
function appendWhenDocumentReady(node: HTMLStyleElement): void {
  const container = document.head ?? document.documentElement;
  if (container) {
    container.appendChild(node);
    return;
  }
  const observer = new MutationObserver(() => {
    const target = document.head ?? document.documentElement;
    if (target) {
      observer.disconnect();
      target.appendChild(node);
    }
  });
  observer.observe(document, { childList: true });
}

function gmAddStyle(css: unknown): HTMLStyleElement | undefined {
  try {
    const style = document.createElement("style");
    style.textContent = String(css);
    appendWhenDocumentReady(style);
    return style;
  } catch {
    return undefined;
  }
}

function storageGet(request: UserScriptStorageGetRequest): UserScriptStorageResult | undefined {
  try {
    return ipcRenderer.sendSync(USERSCRIPT_IPC_CHANNELS.get, request) as
      | UserScriptStorageResult
      | undefined;
  } catch {
    return undefined;
  }
}

function storageSet(request: UserScriptStorageSetRequest): UserScriptStorageResult | undefined {
  try {
    return ipcRenderer.sendSync(USERSCRIPT_IPC_CHANNELS.set, request) as
      | UserScriptStorageResult
      | undefined;
  } catch {
    return undefined;
  }
}

type GmArgs = [
  info: Record<string, unknown>,
  addStyle: (css: unknown) => HTMLStyleElement | undefined,
  getValue: ((key: string, defaultValue?: unknown) => unknown) | undefined,
  setValue: ((key: string, value: unknown) => boolean) | undefined,
  deleteValue: ((key: string) => boolean) | undefined,
  listValues: (() => string[]) | undefined,
];

/**
 * 组装 GM_* 参数。子 frame 仅 GM_info / GM_addStyle；存储函数位传 undefined——
 * main 侧同样会拒绝子 frame 存储请求，这里是双层防线（脚本侧报错被捕获并记录）。
 */
function buildGmArgs(item: UserScriptMatchItem, isMainFrame: boolean): GmArgs {
  const info: Record<string, unknown> = {
    scriptId: item.scriptId,
    name: item.name,
    version: item.version ?? "",
    namespace: item.namespace ?? "",
    runAt: item.runAt,
    grants: item.grants,
    isMainFrame,
  };
  if (!isMainFrame) {
    return [info, gmAddStyle, undefined, undefined, undefined, undefined];
  }
  const scriptId = item.scriptId;
  return [
    info,
    gmAddStyle,
    (key: string, defaultValue?: unknown) => {
      const result = storageGet({ kind: "get", scriptId, key: String(key) });
      return result?.ok === true && "value" in result ? result.value : defaultValue;
    },
    (key: string, value: unknown) => storageSet({ kind: "put", scriptId, key: String(key), value })?.ok === true,
    (key: string) => storageSet({ kind: "delete", scriptId, key: String(key) })?.ok === true,
    () => storageGet({ kind: "list", scriptId })?.keys ?? [],
  ];
}

function executeScript(item: UserScriptMatchItem, isMainFrame: boolean): void {
  try {
    // GM_* 作为函数参数进入脚本作用域：隔离世界不产生 window 全局，脚本之间互不可见。
    const run = new Function(
      "GM_info",
      "GM_addStyle",
      "GM_getValue",
      "GM_setValue",
      "GM_deleteValue",
      "GM_listValues",
      item.code,
    );
    run(...buildGmArgs(item, isMainFrame));
  } catch (error) {
    console.warn(`[userscript] ${item.scriptId} 执行失败:`, error);
  }
}

async function runMatchedScripts(url: string, isMainFrame: boolean): Promise<void> {
  let response: UserScriptMatchResponse | undefined;
  try {
    response = (await ipcRenderer.invoke(USERSCRIPT_IPC_CHANNELS.match, {
      url,
    })) as UserScriptMatchResponse | undefined;
  } catch {
    // main 不可用等场景静默退出，不影响页面本身。
    return;
  }
  if (!response || !Array.isArray(response.scripts)) return;
  for (const item of response.scripts) {
    // main 只回合法 runAt；防御性兜底取最早档，不给未知值静默降级的机会面。
    const runAt = normalizeRunAt(item.runAt) ?? "document-start";
    void waitForRunAt(runAt)
      .then(() => executeScript(item, isMainFrame))
      .catch(() => {});
  }
}

function bootstrap(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  // 幂等守卫：同一 frame 的 JS 上下文内重复注入直接退出（跨导航新上下文自然重置）。
  const installedGlobal = globalThis as typeof globalThis & Record<string, unknown>;
  if (installedGlobal[RUNTIME_INSTALLED_FLAG] === true) return;
  installedGlobal[RUNTIME_INSTALLED_FLAG] = true;

  let url: URL;
  try {
    url = new URL(window.location.href);
  } catch {
    return;
  }
  // 非 http(s) 文档（chrome-error、about:blank、devtools 等）不注入。
  if (!isInjectableUrlProtocol(url.protocol)) return;
  const isMainFrame = window.top === window.self;
  void runMatchedScripts(url.href, isMainFrame);
}

bootstrap();
