import { ipcMain, session, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import { getZCodeDataRootDir, createServiceLogger } from "@zcode/services/node";
import type { ISettingService } from "@zcode/services";
import { PlatformChannels, type IabUserscriptStatusResponse } from "@zcode/shared";
import { EMBEDDED_BROWSER_PARTITION } from "../embeddedBrowserPartition.js";
import {
  USERSCRIPT_IPC_CHANNELS,
  type UserScriptMatchResponse,
  type UserScriptStorageResult,
} from "./userscriptIpcContract.js";
import {
  createUserscriptService,
  isSenderMainFrame,
  readSenderSession,
  type UserscriptRequestContext,
  type UserscriptService,
} from "./userscriptService.js";
import { createUserscriptFileService } from "./userscriptFileService.js";
import { createUserscriptStorage } from "./userscriptStorage.js";
import type { UserscriptManifestPort } from "./userscriptStore.js";

/**
 * IAB 用户脚本装配入口（main 唯一授权点）：
 * 1. 对 persist:zcode-embedded-browser 分区注册唯一的 session 级 preload runtime
 *    （Electron 41 registerPreloadScript，`setPreloads` 已废弃）——一次注册，
 *    挂起/恢复销毁重建 guest 后由 Electron 对每次加载自动生效；
 * 2. 注册 guest IPC 面（恰好 3 个 channel：match / get / set，信任判定全在 main），
 *    以及 renderer 宿主面的状态查询（P2 设置卡，PlatformChannels.IabUserscriptsStatus）。
 * 装配幂等：重复调用不产生第二个 preload 或重复 handler。
 * electron 依赖收敛在本文件；service/store/storage 保持 electron-free 可直测。
 */

export interface InstallIabUserscriptsOptions {
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
  settingService: Pick<ISettingService, "get" | "update">;
  /** 测试注入覆盖；缺省按数据根解析（dev 数据目录隔离随之生效）。 */
  paths?: { scriptsDir?: string; storageRootDir?: string; runtimePreloadPath?: string };
}

const RUNTIME_PRELOAD_ID = "yazcode-iab-userscript-runtime";

let installed = false;
/** 已安装的 service 实例；BrowserCommand 面（P2 三命令）经 getIabUserscriptService 取用。 */
let installedService: UserscriptService | null = null;

/** 未安装（app 未 ready 或测试环境）时返回 null，命令面按 backend_unavailable 降级。 */
export function getIabUserscriptService(): UserscriptService | null {
  return installedService;
}

/** 用户脚本目录：{数据根}/.yazcode/userscripts，默认即 ~/.yazcode/userscripts。 */
export function resolveUserscriptsDir(): string {
  return join(getZCodeDataRootDir(), "userscripts");
}

/** GM 存储目录：{数据根}/.yazcode/userscript-storage。 */
export function resolveUserscriptStorageDir(): string {
  return join(getZCodeDataRootDir(), "userscript-storage");
}

/** runtime 本体：app bundle 内置（与 embeddedBrowserJavaScriptDialog.cjs 同一打包定位模式）。 */
export function resolveUserscriptRuntimePreloadPath(): string {
  return join(import.meta.dirname, "../preload/userscriptRuntime.cjs");
}

/** manifest 经注入的 SettingService 读写 AppSettings.embeddedBrowserUserscripts（唯一所有者）。 */
export function createSettingServiceManifestPort(
  settingService: Pick<ISettingService, "get" | "update">,
): UserscriptManifestPort {
  return {
    async getManifest() {
      const settings = await settingService.get();
      return settings.embeddedBrowserUserscripts ?? {};
    },
    async saveManifest(manifest) {
      await settingService.update({ embeddedBrowserUserscripts: manifest });
    },
  };
}

export function installIabUserscripts(options: InstallIabUserscriptsOptions): void {
  if (installed) {
    return;
  }
  installed = true;

  const runtimePreloadPath =
    options.paths?.runtimePreloadPath ?? resolveUserscriptRuntimePreloadPath();
  // Electron 的 Session 按 persist 分区单例：持住实例既用于注册 preload，
  // 也用于 IPC sender 的分区归属判定（Session 类型没有可读的 partition 属性）。
  const iabSession = session.fromPartition(EMBEDDED_BROWSER_PARTITION);
  iabSession.registerPreloadScript({
    id: RUNTIME_PRELOAD_ID,
    filePath: runtimePreloadPath,
    type: "frame",
  });
  options.logger.info(`[userscripts] runtime preload registered: ${runtimePreloadPath}`);

  // 服务层日志走 createServiceLogger（scope: userscripts）；store/storage 只需 info/warn 端口。
  const serviceLogger = createServiceLogger("userscripts");
  const bootstrapLogger = {
    info: (...args: unknown[]) => serviceLogger.info(undefined, ...args),
    warn: (...args: unknown[]) => serviceLogger.warn(undefined, ...args),
  };
  // storage 全局单例：guest 写入（service）与 P4 删除通道（fileService）必须共享
  // 同一份 per-scriptId 锁表，否则跨实例并发会绕过互斥。
  const storage = createUserscriptStorage({
    rootDir: options.paths?.storageRootDir ?? resolveUserscriptStorageDir(),
    logger: bootstrapLogger,
  });
  const service = createUserscriptService({
    scriptsDir: options.paths?.scriptsDir ?? resolveUserscriptsDir(),
    storageRootDir: options.paths?.storageRootDir ?? resolveUserscriptStorageDir(),
    manifestPort: createSettingServiceManifestPort(options.settingService),
    storage,
    logger: bootstrapLogger,
  });
  installedService = service;

  function requestContext(event: IpcMainEvent | IpcMainInvokeEvent): UserscriptRequestContext {
    return {
      isMainFrame: isSenderMainFrame(event),
      isAllowedSender: readSenderSession(event) === iabSession,
    };
  }

  ipcMain.handle(
    USERSCRIPT_IPC_CHANNELS.match,
    async (event: IpcMainInvokeEvent, payload: unknown): Promise<UserScriptMatchResponse> =>
      service.match(payload, requestContext(event)),
  );
  // get/set 走 sendSync：保持 GM_getValue 的 Tampermonkey 同步语义与 set→get 顺序；
  // handler 异步完成后回填 returnValue，renderer 在此期间保持阻塞。
  ipcMain.on(USERSCRIPT_IPC_CHANNELS.get, (event: IpcMainEvent, payload: unknown) => {
    void service.getStorage(payload, requestContext(event)).then(
      (result) => {
        event.returnValue = result;
      },
      () => {
        event.returnValue = { ok: false, error: "storage_error" } satisfies UserScriptStorageResult;
      },
    );
  });
  ipcMain.on(USERSCRIPT_IPC_CHANNELS.set, (event: IpcMainEvent, payload: unknown) => {
    void service.setStorage(payload, requestContext(event)).then(
      (result) => {
        event.returnValue = result;
      },
      () => {
        event.returnValue = { ok: false, error: "storage_error" } satisfies UserScriptStorageResult;
      },
    );
  });

  // P2 设置卡状态查询（renderer → main）：与 guest IPC 面（恰好 3 个 channel）分离，
  // 走 PlatformChannels 的宿主 invoke 面。只读投影，不做锚定写（契约见 spec P2 行为规则 3）。
  ipcMain.handle(
    PlatformChannels.IabUserscriptsStatus,
    async (): Promise<IabUserscriptStatusResponse> => {
      return { scripts: await service.statusOverview() };
    },
  );

  // P4 自助管理（renderer 宿主面）：read / write / delete / fetchSource。
  // 与 guest 面（恰好 3 个 channel，一个不碰）和 agent 命令面（P2 三命令，刻意不扩）
  // 三线分离；调用方是 renderer 宿主窗口，无需 IAB 分区校验。写盘通道不写 manifest：
  // 落盘 ≠ 批准，manifest patch 是 UI 经 SettingService 的职责（P4 行为规则 1）。
  const fileService = createUserscriptFileService({
    scriptsDir: options.paths?.scriptsDir ?? resolveUserscriptsDir(),
    storageRootDir: options.paths?.storageRootDir ?? resolveUserscriptStorageDir(),
    storage,
    logger: bootstrapLogger,
  });
  ipcMain.handle(PlatformChannels.IabUserscriptsRead, (_event, payload: unknown) =>
    fileService.readScript(payload),
  );
  ipcMain.handle(PlatformChannels.IabUserscriptsWrite, (_event, payload: unknown) =>
    fileService.writeScript(payload),
  );
  ipcMain.handle(PlatformChannels.IabUserscriptsDelete, (_event, payload: unknown) =>
    fileService.deleteScript(payload),
  );
  ipcMain.handle(PlatformChannels.IabUserscriptsFetchSource, (_event, payload: unknown) =>
    fileService.fetchSource(payload),
  );
}
