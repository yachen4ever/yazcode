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
import {
  createUserscriptStore,
  type UserscriptManifestPort,
  type UserScriptStatusItem,
} from "./userscriptStore.js";
import { createUserscriptStorage } from "./userscriptStorage.js";

/**
 * 用户脚本服务层（无 electron 运行时依赖，测试可直跑）：
 * match 按当前扫描结果过滤；get/set 做「合法形状 → 主 frame → scriptId 在服务集内」
 * 三级守卫后落到 GM 存储。信任判定全部在 main，回包不含文件路径。
 * P2 命令面（listStatus/reload/setAgentEnabled）是 BrowserCommand 的 agent 工具面
 * 实现，确认流状态机见 docs/specs/iab-userscripts.md P2 行为规则 2。
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
  const manifestPort = options.manifestPort;
  const store = createUserscriptStore({
    scriptsDir: options.scriptsDir,
    manifestPort,
    logger: options.logger,
  });
  const storage = createUserscriptStorage({
    rootDir: options.storageRootDir,
    logger: options.logger,
  });

  /**
   * 最近注入时刻（P3）：scriptId → epoch ms。唯一写者是 match 的实际回包路径。
   * 为什么纯内存：注入时刻是「本进程服务过」的运行时观测事实，不属于脚本文件事实
   * （store 不持有）也不是用户决策（manifest 不持有）；落盘会引入第二个所有者与
   * 时钟漂移问题，因此进程重启即清零。
   * 语义边界：记录点是**回包**而非脚本执行完成——document-end/document-idle 脚本
   * 的回包先于实际执行，该值表示「最近一次开始服务」。
   */
  const lastInjectedAt = new Map<string, number>();

  /**
   * 合并注入时刻，并按当前扫描集合裁剪内存表：已删除脚本不留残留条目，
   * 否则内存表会随删除/改名无限增长（同一 scriptId 重新落盘会「复活」旧时刻）。
   */
  function withLastInjected(states: UserScriptStatusItem[]): UserScriptStatusItem[] {
    const scanned = new Set(states.map((item) => item.scriptId));
    for (const scriptId of lastInjectedAt.keys()) {
      if (!scanned.has(scriptId)) lastInjectedAt.delete(scriptId);
    }
    return states.map(mergeLastInjected);
  }

  /** 单条合并（不裁剪）：命令回包与状态列表返回同一形状，调用方无需区分来源。 */
  function mergeLastInjected(item: UserScriptStatusItem): UserScriptStatusItem {
    const injectedAt = lastInjectedAt.get(item.scriptId);
    // 无记录时字段缺席（不写 null/0），避免 UI 呈现伪造的注入时间。
    return injectedAt === undefined ? item : { ...item, lastInjectedAt: injectedAt };
  }

  return {
    /**
     * userscript_list：只读状态投影（不做锚定写）。agent 观察面，
     * 回包不含脚本代码与文件路径。
     */
    async listStatus(): Promise<UserScriptStatusItem[]> {
      return withLastInjected(await store.inspect());
    },

    /**
     * 设置卡状态查询（P2）：inspect 状态 + GM 存储健康探测（仅有存储文件的脚本）。
     * 与 agent 观察面分离——存储健康是用户运维信息，不进 agent 命令回包。
     */
    async statusOverview(): Promise<
      Array<UserScriptStatusItem & { storageHealth: "ok" | "corrupt" }>
    > {
      const statuses = withLastInjected(await store.inspect());
      return await Promise.all(
        statuses.map(async (item) => ({
          ...item,
          storageHealth: (await storage.hasStorageFile(item.scriptId))
            ? await storage.probeHealth(item.scriptId)
            : ("ok" as const),
        })),
      );
    },

    /**
     * userscript_reload：立即执行一次完整扫描（含 P1 锚定语义）后重导出状态。
     * 无扫描缓存可失效，命令幂等；存在意义是给 agent 一个明确的「刷新事实」动作。
     */
    async reload(): Promise<UserScriptStatusItem[]> {
      await store.scan();
      return withLastInjected(await store.inspect());
    },

    /**
     * userscript_set_enabled（agent 来源确认流状态机）：
     * - enabled=false：直接禁用（降权直达），清 sha 与 pendingApproval；
     * - enabled=true：绝不直接启用——落 pendingApproval（enabled=false + 清 sha），
     *   待用户在设置卡批准；已处于已批准态（serving / enabled_pending_anchor）时幂等 no-op。
     * manifest 读改写与 P1 锚定写共享同一条 SettingService 写路径；目录规模个位数，
     * 并发写风险与 P1 锚定路径一致（last-write-wins，下次扫描自愈）。
     */
    async setAgentEnabled(
      scriptId: string,
      enabled: boolean,
    ): Promise<
      | { ok: true; changed: boolean; status: UserScriptStatusItem }
      | { ok: false; error: "unknown_script" }
    > {
      const statuses = await store.inspect();
      const target = statuses.find((item) => item.scriptId === scriptId);
      if (!target) {
        return { ok: false, error: "unknown_script" };
      }
      if (enabled && (target.status === "serving" || target.status === "enabled_pending_anchor")) {
        // 已批准态：agent 的启用请求已满足，不写 manifest（幂等）。
        return { ok: true, changed: false, status: mergeLastInjected(target) };
      }

      const manifest = await manifestPort.getManifest();
      manifest[scriptId] = enabled
        ? { enabled: false, pendingApproval: true }
        : { enabled: false };
      await manifestPort.saveManifest(manifest);
      options.logger.info(
        `[userscripts] agent set_enabled ${scriptId} enabled=${enabled} -> ${
          enabled ? "pendingApproval" : "disabled"
        }`,
      );

      const next = (await store.inspect()).find((item) => item.scriptId === scriptId);
      // 回包与列表条目同形：同一类型在 agent 侧只有一种形状（不新增第二种投影）。
      return { ok: true, changed: true, status: mergeLastInjected(next ?? target) };
    },
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
      // 只记真正回包给该 frame 的脚本（服务集条目不等于命中）：
      // 同一脚本多 frame 注入时后写覆盖，值语义 = 最近一次实际注入。
      const injectedAt = Date.now();
      for (const def of serveable) {
        if (!urlMatchesAnyPattern(url, def.compiledPatterns)) continue;
        lastInjectedAt.set(def.scriptId, injectedAt);
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
