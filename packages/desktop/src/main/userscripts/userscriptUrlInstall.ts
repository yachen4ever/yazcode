import {
  USER_SCRIPT_URL_FETCH_TIMEOUT_MS,
  USER_SCRIPT_URL_MAX_BYTES,
  USER_SCRIPT_URL_MAX_REDIRECTS,
} from "@zcode/shared";
import type { IabUserscriptFetchSourceResult, IabUserscriptSourcePreview } from "@zcode/shared";
import {
  fetchRemoteWithGuard,
  RemoteFetchError,
  type RemoteFetchImpl,
  type RemoteLookupImpl,
} from "../remoteFetchGuard.js";
import { buildUserScriptDef, parseUserScriptHeader, normalizeRunAt } from "./userscriptRules.js";
import { computeScriptSha256 } from "./userscriptStore.js";

/**
 * P4 从 URL 安装的段 1（拉取 + 静态预览）：**不写盘**——源码只在内存里随结果返回，
 * 安装（写盘）是用户在预览段确认后的独立调用（三段确认红线 3）。
 *
 * 守卫复用 remoteFetchGuard（与 desktopSaveFile 同一套 SSRF 防护），P4 参数：
 * https-only、20MB（边读边计数，无 content-length 的 chunked 同样拦截）、20s 超时、
 * ≤5 跳重定向且每跳重新校验协议与地址。
 * 预览复用 buildUserScriptDef 的同一套解析，保证「预览所见 = 安装后扫描所得」；
 * 静态拒载（解析失败 / grant 白名单外）统一落 preview.parseError，由 UI 在段 2
 * 阻断安装——这两种状态永远不会执行，装了只会留一条永久惰性的噪音行。
 */

export interface FetchUserscriptSourceDeps {
  /** 测试注入；缺省 undici fetch。 */
  fetchImpl?: RemoteFetchImpl;
  /** 测试注入；缺省 dns.promises.lookup。 */
  lookupImpl?: RemoteLookupImpl;
  /** 测试注入；缺省 USER_SCRIPT_URL_FETCH_TIMEOUT_MS（20s）。 */
  timeoutMs?: number;
}

/** preview 的 name 兜底：URL 无 @name 时以路径文件名 stem 呈现，再兜底 "userscript"。 */
function fallbackNameFromUrl(url: URL): string {
  const segments = url.pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last) return "userscript";
  const stem = last.replace(/\.user\.js$/i, "").replace(/\.[a-z]+$/i, "");
  return stem || "userscript";
}

function previewFromParseFailure(
  code: string,
  fallbackName: string,
  parseError: string,
): IabUserscriptSourcePreview {
  const header = parseUserScriptHeader(code);
  return {
    name: header?.name || fallbackName,
    runAt: normalizeRunAt(header?.runAt) ?? "document-start",
    grants: [],
    // 声明的 @match 原样透出：用户能看到「声明了什么」与「为什么被拒」并列。
    match: header?.matchPatterns ?? [],
    parseError,
  };
}

export async function fetchUserscriptSource(
  rawUrl: string,
  deps: FetchUserscriptSourceDeps = {},
): Promise<IabUserscriptFetchSourceResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, error: "invalid_url" };
  }
  // https-only（spec P4 红线 3）：脚本源码将进入执行面，明文传输不做降级放行。
  if (url.protocol !== "https:") return { ok: false, error: "not_https" };

  let guardResult;
  try {
    guardResult = await fetchRemoteWithGuard(url, {
      allowedProtocols: ["https:"],
      maxRedirects: USER_SCRIPT_URL_MAX_REDIRECTS,
      maxBytes: USER_SCRIPT_URL_MAX_BYTES,
      timeoutMs: deps.timeoutMs ?? USER_SCRIPT_URL_FETCH_TIMEOUT_MS,
      fetchImpl: deps.fetchImpl,
      lookupImpl: deps.lookupImpl,
    });
  } catch (error) {
    if (error instanceof RemoteFetchError) {
      // 重定向跳到非 https（guard 的 protocol_not_allowed）也归 not_https，
      // 与初始地址的 https-only 文案一致。
      switch (error.code) {
        case "too_large":
          return { ok: false, error: "too_large" };
        case "timeout":
          return { ok: false, error: "timeout" };
        case "remote_address_not_allowed":
          return { ok: false, error: "remote_address_not_allowed" };
        case "protocol_not_allowed":
          return { ok: false, error: "not_https" };
        default:
          return { ok: false, error: "download_failed" };
      }
    }
    return { ok: false, error: "download_failed" };
  }

  // 空 body 不构成「可解析的脚本」：按下载异常处理，不生成一条必然 parse 失败的预览。
  if (guardResult.bytes === null || guardResult.totalBytes === 0) {
    return { ok: false, error: "download_failed" };
  }
  const content = Buffer.from(guardResult.bytes).toString("utf8");
  const fallbackName = fallbackNameFromUrl(guardResult.finalUrl);

  const parsed = buildUserScriptDef({
    scriptId: fallbackName,
    code: content,
    sha256: computeScriptSha256(Buffer.from(content, "utf8")),
    fallbackName,
  });
  const preview: IabUserscriptSourcePreview = parsed.ok
    ? {
        name: parsed.def.name,
        ...(parsed.def.version ? { version: parsed.def.version } : {}),
        runAt: parsed.def.runAt,
        grants: parsed.def.grants,
        match: parsed.def.matchPatterns,
      }
    : previewFromParseFailure(content, fallbackName, parsed.reason);

  return {
    ok: true,
    source: { url: guardResult.finalUrl.toString(), content },
    preview,
  };
}
