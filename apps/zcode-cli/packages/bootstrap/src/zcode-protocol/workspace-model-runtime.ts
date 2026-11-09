/* eslint-disable max-lines -- workspace 模型协议与兼容请求处理仍集中在本文件。 */
import { createInMemorySessionEventStore } from "@zcode/adapters/storage";
import type { ModelSelection } from "@zcode/contracts";
import {
  zcodeProviderTestModelConnectivityParamsSchema,
  zcodeWorkspaceReadPresentationParamsSchema,
  type ZCodeProviderTestModelConnectivityParams,
  type ZCodeWorkspaceRef,
} from "@zcode/shared";
import type { ZCodeApp, ZCodeAppOptions } from "../app/types.js";
import { listProtocolSlashCommands } from "./slash-commands.js";
import {
  parseParams,
  type ZCodeProtocolAgentServerContext,
  type ZCodeProtocolSessionRecord,
} from "./server-types.js";
import { runSessionModelConfigMutation } from "../zcode-protocol-v4/model-config-mutation.js";
import { createProviderRuntimeHeadersPort } from "./provider-runtime-headers.js";

export async function readWorkspacePresentation(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeWorkspaceReadPresentationParamsSchema, rawParams);
  return {
    workspace: params.workspace,
    mode: "build" as const,
    slashCommands: await listProtocolSlashCommands({
      // 灰度门是 Host 判定的 workspace 级事实，目录装配读进程缓存。
      dynamicWorkflowEnabled: context.appRuntimePreferences.dynamicWorkflowEnabled,
      env: context.deps.env,
      logger: context.logger,
      workingDirectory: params.workspace.workspacePath,
    }),
  };
}

/**
 * 无活跃会话时探测创建的 app 按工作区键缓存复用（26.5.8 前缀段优化，spec
 * probe-registry-refresh-dedup.md）：设置页连续探测不再反复冷启+即拆。
 * app 的探针选择绑定读共享 registry 的调用时活视图（session-facade 的
 * completeAuxiliaryRegistryModelSelection），refresh 后缓存 app 天然看到新配置。
 * TTL 到期关闭兜底资源生命周期；连接断开最多延迟一个 TTL，进程退出由 OS 兜底。
 */
const PROBE_APP_TTL_MS = 60_000;

interface ProbeAppCacheEntry {
  app: ZCodeApp;
  closeTimer: ReturnType<typeof setTimeout>;
}

interface ProbeAppStore {
  cache: Map<string, ProbeAppCacheEntry>;
  inFlight: Map<string, Promise<ZCodeApp>>;
}

const probeAppStores = new WeakMap<ZCodeProtocolAgentServerContext, ProbeAppStore>();

function probeAppStoreFor(context: ZCodeProtocolAgentServerContext): ProbeAppStore {
  let store = probeAppStores.get(context);
  if (!store) {
    store = { cache: new Map(), inFlight: new Map() };
    probeAppStores.set(context, store);
  }
  return store;
}

function armProbeAppEviction(
  store: ProbeAppStore,
  key: string,
  app: ZCodeApp,
): void {
  // 同键覆盖（并发探测先后收尾）：清掉旧条目的 timer，避免旧 timer 到期时
  // 把新条目从缓存里误删。
  const previous = store.cache.get(key);
  if (previous) clearTimeout(previous.closeTimer);
  const closeTimer = setTimeout(() => {
    // 身份核对：期间若条目已被 checkout/覆盖，不得误删或重复关闭。
    const current = store.cache.get(key);
    if (current?.app === app) store.cache.delete(key);
    void app.close?.();
  }, PROBE_APP_TTL_MS);
  store.cache.set(key, { app, closeTimer });
}

export async function testProviderModelConnectivity(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  abortSignal?: AbortSignal,
) {
  const params = parseParams(zcodeProviderTestModelConnectivityParamsSchema, rawParams);
  // 旧 Personal Config 跨进程 watcher 可能永久漏掉原子写事件；连接测试若不先
  // 主动刷新，会反复查询旧 Registry。这里复用正式 Registry refresh，不旁路创建配置事实。
  // 去重收紧（26.5.9 修复批，spec probe-registry-refresh-dedup.md）：26.5.8 曾仅凭
  // 「Host 已推送 account config」就跳过本刷新——该假设在 Base URL（personal 侧）维度
  // 不成立：推送路径的 refresh 可能发生在 personal 文件落盘之前，跳过会读到旧 Base
  // URL（#29 八轮实测退化）。修正后要求两项同时成立才允许跳过：
  //   1) Host 本探测前确实推送了 account config（接收 handler 已刷新一次）；
  //   2) 该次 refresh 自证覆盖当前 config 源（builtin+personal）——即此后 config 源
  //      没有再变化（registry-refresh-freshness）。任一不成立/无法自证 → 照旧刷新，
  //      fail-open 落在「多刷新一次」的安全侧。
  const canReusePushedRefresh =
    params.accountConfigPushed === true && context.deps.isRegistryRefreshCurrent?.() === true;
  if (!canReusePushedRefresh) {
    await context.deps.refreshProviderRegistry?.("provider-connectivity");
  }
  const store = probeAppStoreFor(context);
  const workspaceKey = params.workspace.workspaceKey;
  const active = Array.from(context.sessions.values()).find(
    (record) => record.workspace.workspaceKey === workspaceKey,
  );
  if (active) {
    // 活跃会话优先用会话自己的 app；缓存条目（如有）闲置由 TTL 自然出清。
    await active.app.testModelConnectivity(
      { selection: params.selection as ModelSelection },
      { abortSignal },
    );
    return { success: true as const };
  }
  const cached = store.cache.get(workspaceKey);
  let app: ZCodeApp;
  if (cached) {
    // checked-out：探测期间取消 TTL 回收，探测结束重新武装——长探测（黑洞档
    // 10s、挂起环境更久）不会被 60s 定时器中途关闭。
    clearTimeout(cached.closeTimer);
    store.cache.delete(workspaceKey);
    app = cached.app;
  } else {
    app = await acquireProbeApp(context, store, workspaceKey, params);
  }
  try {
    await app.testModelConnectivity(
      { selection: params.selection as ModelSelection },
      { abortSignal },
    );
    return { success: true as const };
  } finally {
    // 用后重新武装 TTL：缓存的 app 在连续探测间复用，到期才关闭。
    armProbeAppEviction(store, workspaceKey, app);
  }
}

async function acquireProbeApp(
  context: ZCodeProtocolAgentServerContext,
  store: ProbeAppStore,
  workspaceKey: string,
  params: ZCodeProviderTestModelConnectivityParams,
): Promise<ZCodeApp> {
  const inFlight = store.inFlight.get(workspaceKey);
  if (inFlight) return inFlight;
  const created = createWorkspaceZCodeApp(context, params.workspace, {
    env: context.deps.env,
    eventStore: createInMemorySessionEventStore(),
    runtimeConfig: { workingDirectory: params.workspace.workspacePath },
    sessionStore: context.deps.sessionStore,
    version: context.deps.version,
  });
  const tracked = created.then(
    (app) => {
      store.inFlight.delete(workspaceKey);
      return app;
    },
    (error: unknown) => {
      store.inFlight.delete(workspaceKey);
      throw error;
    },
  );
  store.inFlight.set(workspaceKey, tracked);
  return tracked;
}

export async function createWorkspaceZCodeApp(
  context: ZCodeProtocolAgentServerContext,
  workspace: ZCodeWorkspaceRef,
  options: Omit<ZCodeAppOptions, "providerRegistry">,
): Promise<ZCodeApp> {
  const providerRuntimeHeadersPort =
    options.providerRuntimeHeadersPort ?? createProviderRuntimeHeadersPort(context, workspace);
  return context.deps.createZCodeApp({
    ...options,
    // 协议宿主有内联视图渲染面，visualize 插件只在 stdio 协议入口加载。
    includeVisualize: true,
    platform: context.deps.platform,
    providerRuntimeHeadersPort,
    runtimeConfig: {
      ...options.runtimeConfig,
      // createZCodeApp 会把 workingDirectory 规范化为执行 cwd。把协议入口的
      // workspacePath 单独注入 runtime，session 持久化才能保留本地 workspaceKey 的路径表示。
      workspacePath: workspace.workspacePath,
      // 远端 session 是 shared-host CUA 的第二层隔离边界：不能只传 workspacePath/identity，
      // 否则同一远端 workspace 的不同 attachment 会复用 Accessibility frame/action 状态。
      // 放在这个 helper 里而不是各调用点，是为了两条 session 创建路径都拿到同一份隔离键。
      ...(workspace.remoteSessionId ? { remoteSessionId: workspace.remoteSessionId } : {}),
      ...(workspace.workspaceIdentity
        ? {
            memory: {
              ...options.runtimeConfig?.memory,
              workspaceIdentity: workspace.workspaceIdentity,
            },
          }
        : {}),
      // Electron/Protocol 主会话之前没有像 CLI/TUI 那样显式开启模型流式，
      // 导致主 turn 退回 generateText 非流式请求，遇到返回 SSE 的兼容端点会按 JSON 解析失败。
      modelStreaming: options.runtimeConfig?.modelStreaming ?? "on",
    },
  });
}

export function hasSessionModelProvider(
  _context: ZCodeProtocolAgentServerContext,
  record: Pick<ZCodeProtocolSessionRecord, "app" | "workspace">,
  providerId: string,
): boolean {
  return record.app.listModels().some((model) => model.ref.providerId === providerId);
}

async function ensureSessionModelAvailableUnlocked(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
): Promise<boolean> {
  // 存量模型失效时不能静默改成 Registry 第一项覆盖用户选择；失效选择保持未绑定，
  // 由恢复/Composer 的选择校验和首发门禁处理；这里不能再写入另一份默认模型事实。
  // 保留该过渡入口是为了让旧协议调用方平稳退场。
  void context;
  void record;
  return false;
}

export async function ensureSessionModelAvailable(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
): Promise<boolean> {
  return runSessionModelConfigMutation(record.app, () =>
    ensureSessionModelAvailableUnlocked(context, record),
  );
}

export function resolveSessionModelContextWindow(
  _context: ZCodeProtocolAgentServerContext,
  record: Pick<ZCodeProtocolSessionRecord, "app" | "workspace" | "restoredModelSelection">,
): number | undefined {
  // 缺档位会让恢复选择暂不绑定 Runtime，但模型身份仍可只读查询容量，不能伪造 20 万。
  const selection = record.app.runtime.getSessionModelSelection() ?? record.restoredModelSelection;
  const value = selection && record.app.getModelOption?.(selection)?.contextWindow;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
