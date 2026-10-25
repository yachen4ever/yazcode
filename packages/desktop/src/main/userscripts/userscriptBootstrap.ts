import { ipcMain, session, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import { getZCodeDataRootDir } from "@zcode/services/node";
import type { ISettingService } from "@zcode/services";
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
} from "./userscriptService.js";
import type { UserscriptManifestPort } from "./userscriptStore.js";

/**
 * IAB 用户脚本装配入口（main 唯一授权点）：
 * 1. 对 persist:zcode-embedded-browser 分区注册唯一的 session 级 preload runtime
 *    （Electron 41 registerPreloadScript，`setPreloads` 已废弃）——一次注册，
 *    挂起/恢复销毁重建 guest 后由 Electron 对每次加载自动生效；
 * 2. 注册恰好 3 个 IPC channel（match / get / set），信任判定全在 main。
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

  const runtimePreloadPath = options.paths?.runtimePreloadPath ?? resolveUserscriptRuntimePreloadPath();
  // Electron 的 Session 按 persist 分区单例：持住实例既用于注册 preload，
  // 也用于 IPC sender 的分区归属判定（Session 类型没有可读的 partition 属性）。
  const iabSession = session.fromPartition(EMBEDDED_BROWSER_PARTITION);
  iabSession.registerPreloadScript({
    id: RUNTIME_PRELOAD_ID,
    filePath: runtimePreloadPath,
    type: "frame",
  });
  options.logger.info(`[userscripts] runtime preload registered: ${runtimePreloadPath}`);

  const service = createUserscriptService({
    scriptsDir: options.paths?.scriptsDir ?? resolveUserscriptsDir(),
    storageRootDir: options.paths?.storageRootDir ?? resolveUserscriptStorageDir(),
    manifestPort: createSettingServiceManifestPort(options.settingService),
    logger: options.logger,
  });

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
}
