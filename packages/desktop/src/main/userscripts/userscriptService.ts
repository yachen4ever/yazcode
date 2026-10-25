import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import {
  parseMatchRequestUrl,
  parseStorageGetRequest,
  parseStorageSetRequest,
  type UserScriptMatchItem,
  type UserScriptMatchResponse,
  type UserScriptStorageResult,
} from "./userscriptIpcContract.js";
import { isValidStorageKey, urlMatchesAnyPattern } from "./userscriptRules.js";
import { createUserscriptStore, type UserscriptManifestPort } from "./userscriptStore.js";
import { createUserscriptStorage } from "./userscriptStorage.js";

/**
 * 用户脚本服务层（无 electron 运行时依赖，测试可直跑）：
 * match 按当前扫描结果过滤；get/set 做「合法形状 → 主 frame → scriptId 在服务集内」
 * 三级守卫后落到 GM 存储。信任判定全部在 main，回包不含文件路径。
 */

export interface UserscriptServiceLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export interface CreateUserscriptServiceOptions {
  scriptsDir: string;
  storageRootDir: string;
  manifestPort: UserscriptManifestPort;
  logger: UserscriptServiceLogger;
}

export interface UserscriptRequestContext {
  /** main 侧判定的主 frame（以 senderFrame 为准，不信任 renderer 传参）。 */
  isMainFrame: boolean;
  /**
   * sender session 是否为 IAB 分区会话。Electron 的 Session 对象按分区单例，
   * bootstrap 以对象同一性判定（Session 类型没有可读的 partition 属性）。
   */
  isAllowedSender: boolean;
}

function isSenderAllowed(context: UserscriptRequestContext): boolean {
  return context.isAllowedSender;
}

function storageFailure(error: NonNullable<UserScriptStorageResult["error"]>): UserScriptStorageResult {
  return { ok: false, error };
}

export function createUserscriptService(options: CreateUserscriptServiceOptions) {
  const store = createUserscriptStore({
    scriptsDir: options.scriptsDir,
    manifestPort: options.manifestPort,
    logger: options.logger,
  });
  const storage = createUserscriptStorage({
    rootDir: options.storageRootDir,
    logger: options.logger,
  });

  return {
    /**
     * match：非 http(s)、非法入参或非 IAB 分区请求返回空集（no-op），
     * 与 runtime 的 scheme 守卫互为冗余防线。
     */
    async match(payload: unknown, context: UserscriptRequestContext): Promise<UserScriptMatchResponse> {
      if (!isSenderAllowed(context)) return { scripts: [] };
      const url = parseMatchRequestUrl(payload);
      if (!url) return { scripts: [] };
      const { serveable } = await store.scan();
      const scripts: UserScriptMatchItem[] = [];
      for (const def of serveable) {
        if (!urlMatchesAnyPattern(url, def.compiledPatterns)) continue;
        scripts.push({
          scriptId: def.scriptId,
          name: def.name,
          runAt: def.runAt,
          grants: def.grants,
          ...(def.version ? { version: def.version } : {}),
          ...(def.namespace ? { namespace: def.namespace } : {}),
          code: def.code,
        });
      }
      return { scripts };
    },

    /** GM_getValue / GM_listValues（sendSync 通道）。 */
    async getStorage(payload: unknown, context: UserscriptRequestContext): Promise<UserScriptStorageResult> {
      if (!isSenderAllowed(context)) return storageFailure("invalid_request");
      if (!context.isMainFrame) {
        // 仅主 frame 提供 GM 存储（子 frame 只允许 addStyle），防 iframe 抢写共享存储。
        return storageFailure("sub_frame_denied");
      }
      const request = parseStorageGetRequest(payload);
      if (!request) return storageFailure("invalid_request");
      if (request.kind === "get" && !isValidStorageKey(request.key)) {
        return storageFailure("invalid_key");
      }
      const { serveable } = await store.scan();
      if (!serveable.some((def) => def.scriptId === request.scriptId)) {
        return storageFailure("unknown_script");
      }
      return request.kind === "get"
        ? storage.getValue(request.scriptId, request.key)
        : storage.listValues(request.scriptId);
    },

    /** GM_setValue / GM_deleteValue（sendSync 通道）。 */
    async setStorage(payload: unknown, context: UserscriptRequestContext): Promise<UserScriptStorageResult> {
      if (!isSenderAllowed(context)) return storageFailure("invalid_request");
      if (!context.isMainFrame) return storageFailure("sub_frame_denied");
      const request = parseStorageSetRequest(payload);
      if (!request) return storageFailure("invalid_request");
      if (!isValidStorageKey(request.key)) return storageFailure("invalid_key");
      const { serveable } = await store.scan();
      if (!serveable.some((def) => def.scriptId === request.scriptId)) {
        return storageFailure("unknown_script");
      }
      return request.kind === "put"
        ? storage.setValue(request.scriptId, request.key, request.value)
        : storage.deleteValue(request.scriptId, request.key);
    },
  };
}

export type UserscriptService = ReturnType<typeof createUserscriptService>;

/** main 侧主 frame 判定：以 senderFrame 为准；frame 已销毁等异常场景 fail-closed。 */
export function isSenderMainFrame(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  try {
    return event.senderFrame?.parent === null;
  } catch {
    return false;
  }
}

/** sender session 读取；异常场景返回 null（fail-closed）。分区归属由 bootstrap 以对象同一性比对。 */
export function readSenderSession(event: IpcMainEvent | IpcMainInvokeEvent): unknown {
  try {
    return event.sender.session;
  } catch {
    return null;
  }
}
