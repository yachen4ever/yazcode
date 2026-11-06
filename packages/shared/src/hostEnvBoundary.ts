/**
 * 宿主环境注入面边界原语（deny-by-default）。
 *
 * spec：docs/specs/host-env-injection-boundary.md。背景：宿主 zcode 会向子进程注入
 * ZCODE_/YAZCODE_ 前缀变量（官方 legacy 名还有 ZCODIUM_），yazcode 作为独立产品线
 * 不消费这些注入——历轮反应式修复（手动清变量 / CLI 点名洗涤 / R1 electron-builder
 * strip / R2 运行时锁源）都因「点名式防护 vs 开放集合」反复漏网。
 *
 * 本原语是唯一语义：凡宿主注入前缀的键一律剔除，例外只有两类可信来源——
 * ① dev 调试通道集（开发者显式配置，`.env` 与启动脚本）；
 * ② 发布注入集（**仅** CI 发布链注入，构建脚本显式开启）。
 * 非前缀键（PATH/HOME/NODE_OPTIONS 等）不受影响。
 */

/** 宿主注入面的三条命名前缀（旧名 / 改名后新名 / 官方 legacy 名）。 */
export const HOST_INJECTION_ENV_PREFIXES = ["ZCODE_", "YAZCODE_", "ZCODIUM_"] as const;

/**
 * 发布注入集（唯一事实源 = .github/workflows/release.yml 实际注入的变量）。
 * 只有 CI 发布链会注入这些键；本地构建**不得**信任同名环境变量（宿主可能注入
 * 旧版本号，见 mint 双盲 F1 的「版本烤入宿主版本号」事故）。
 */
export const PUBLISH_INJECTION_ENV_ALLOWLIST = [
  "ZCODE_DIST_BASE_URL",
  "ZCODE_ENV",
  "ZCODE_APP_VERSION",
  "ZCODIUM_REMOTE_ASSET_CDN_BASE_URL",
] as const;

/**
 * dev 调试通道集（显式开发者配置：.env 文件通道与启动脚本变量）。
 * 始终可信——它是开发者自己写的，不是宿主注入。
 */
export const DEV_CHANNEL_ENV_ALLOWLIST = [
  // 环境身份与数据根隔离
  "ZCODE_DATA_BASE_DIR",
  "YAZCODE_DATA_BASE_DIR",
  "ZCODIUM_DATA_BASE_DIR",
  "ZCODE_STORAGE_DIR",
  "YAZCODE_STORAGE_DIR",
  "ZCODIUM_STORAGE_DIR",
  // 构建期键（打包态无害——构建期不读它们）
  "ZCODE_DESKTOP_DIST_DIR",
  "ZCODE_DESKTOP_AGENT_BYTECODE",
  "ZCODE_DESKTOP_AGENT_BUILD_MODE",
  // 构建链开关与镜像
  "ZCODE_BOOTSTRAP_WITH_REMOTE",
  "ZCODE_SKIP_PREPARE",
  "ZCODE_SKIP_BUILD",
  "ZCODE_TARGET_OS",
  "ZCODE_TARGET_ARCH",
  "ZCODE_ELECTRON_RUNTIME_MIRROR",
  "ZCODE_DEPS_BASE_URL",
  "ZCODE_NODE_DIST_MIRROR",
  "ZCODE_ENABLE_MAC_SIGN",
  "ZCODE_CUA_HELPER_BUILD_ID",
  "ZCODE_PREVIEW_IDENTITY",
  // CUA 与调试开关
  "ZCODE_CUA_DEV_MODE",
  "ZCODE_CUA_PRODUCT_HELPER",
  "ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL",
  "ZCODE_DEBUG",
  // E2E 通道
  "ZCODE_E2E_COVERAGE",
  "ZCODE_E2E_ARTIFACT_DIR",
  "ZCODE_E2E_RUN_ID",
  "ZCODE_E2E_RUNTIME_LOG_DIR",
  "ZCODE_E2E_KEEP_BUILD_CACHE",
  "ZCODE_E2E_ASK_USER_QUESTION_CLOCK_SCALE",
  "ZCODE_E2E_FS_FAULTS",
] as const;

/**
 * 仅 dev 态可信的运行时键（桌面数据隔离目录族）。
 *
 * dev 态必须存活——e2e 与并行 dev 实例靠它们隔离数据目录与应用身份；打包态必须
 * 剔除——宿主可借此顶替用户数据落盘位置、Electron 单实例锁身份与工作区根
 * （总账 R2 组）。故与「构建期无害」的 dev 通道键分开管理。
 */
export const DEV_RUNTIME_ONLY_ENV_ALLOWLIST = [
  "ZCODE_DESKTOP_APPLICATION_NAME",
  "ZCODE_DESKTOP_HOME_DIR",
  "ZCODE_DESKTOP_USER_DATA_DIR",
  "ZCODE_DESKTOP_SESSION_DATA_DIR",
  "ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA",
  // E2E 故障注入门控（打包态剔除——宿主注入即可在生产打开 FS 故障注入，总账 R6）
  "ZCODE_E2E_FS_FAULTS_ALLOW",
  // 环境身份（dev 态合法——启动脚本选 test/production；打包态不可信——宿主注入即
  // 翻转构建环境与运行模式；CI 发布态由发布注入集提供）
  "ZCODE_ENV",
  // 端点与资源源（打包态剔除——宿主顶替即改道 API 流量或把攻击者源烤进产物，
  // 总账 R3/R8 组；dev 态则必须存活以支持指向自建网关/本地 CDN）
  "ZCODE_BASE_URL",
  "YAZCODE_BASE_URL",
  "ZCODE_ENDPOINT_ORIGIN",
  "YAZCODE_ENDPOINT_ORIGIN",
  "ZCODE_CDN_BASE_URL",
  "YAZCODE_CDN_BASE_URL",
  "ZCODE_REMOTE_ASSET_CDN_BASE_URL",
  "YAZCODE_REMOTE_ASSET_CDN_BASE_URL",
  "ZCODIUM_REMOTE_ASSET_CDN_BASE_URL",
] as const;

const DEV_RUNTIME_ONLY_SET = new Set<string>(DEV_RUNTIME_ONLY_ENV_ALLOWLIST);
const DEV_CHANNEL_SET = new Set<string>(DEV_CHANNEL_ENV_ALLOWLIST);
const PUBLISH_INJECTION_SET = new Set<string>(PUBLISH_INJECTION_ENV_ALLOWLIST);

export interface HostEnvStripOptions {
  /**
   * 是否额外信任发布注入集（release.yml 的四个变量）。
   * 仅 CI 发布链构建脚本置 true；本地构建保持 false——宿主可能注入同名旧版本号。
   */
  readonly allowPublishInjection?: boolean;
  /**
   * 是否信任仅 dev 态可信的运行时键（桌面数据隔离目录族、环境身份、端点与
   * 资源源、FS 故障注入门控）。
   * 默认 false（deny-by-default）——只在 dev 启动器（scripts/dev-desktop-env.mjs）
   * 这一个可信上下文显式开启；构建期与打包态运行时一律剔除。
   */
  readonly allowDevRuntimeKeys?: boolean;
  /** 额外信任的键（按需追加，如某个测试专用的显式注入）。 */
  readonly extraAllowlist?: readonly string[];
}

/** 某次剥离的白名单集合。 */
export function resolveHostEnvAllowlist(options?: HostEnvStripOptions): ReadonlySet<string> {
  const allowlist = new Set<string>(DEV_CHANNEL_SET);
  // dev-runtime-only 族默认不信任（deny-by-default）：它们只在 dev 启动器这一处
  // 是可信的开发者配置；其余上下文（构建期、打包态运行时）都由宿主注入面覆盖，
  // 放行即改写构建环境 / 用户数据落盘位置。
  if (options?.allowDevRuntimeKeys === true) {
    for (const key of DEV_RUNTIME_ONLY_SET) allowlist.add(key);
  }
  if (options?.allowPublishInjection) {
    for (const key of PUBLISH_INJECTION_SET) allowlist.add(key);
  }
  for (const key of options?.extraAllowlist ?? []) allowlist.add(key);
  return allowlist;
}

/** 该键是否带宿主注入前缀（判定为污染面，除非在白名单）。 */
export function isHostInjectionEnvKey(key: string): boolean {
  return HOST_INJECTION_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * deny-by-default 洗涤：剔除全部宿主注入前缀键（白名单除外），保留其余键。
 * 纯函数——不改入参，返回新对象；undefined 值按环境语义剔除。
 */
export function stripHostInjectedEnv<T extends Record<string, string | undefined>>(
  env: T,
  options?: HostEnvStripOptions,
): Record<string, string> {
  const allowlist = resolveHostEnvAllowlist(options);
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (isHostInjectionEnvKey(key) && !allowlist.has(key)) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

/**
 * 就地洗涤（进程级早期剥离用）：删除入参对象上的污染键。
 * 与 stripHostInjectedEnv 同语义，但作用于既有对象（进程 env 本身）。
 */
export function stripHostInjectedEnvInPlace(
  env: Record<string, string | undefined>,
  options?: HostEnvStripOptions,
): void {
  const allowlist = resolveHostEnvAllowlist(options);
  for (const key of Object.keys(env)) {
    if (isHostInjectionEnvKey(key) && !allowlist.has(key)) {
      delete env[key];
    }
  }
}
