import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServiceLogger } from "../logger/serviceLogger.js";
import {
  buildOpenVikingMcpServerConfig,
  INTEGRATION_ID,
  INTEGRATION_VERSION,
  verifyMcpProxyHandshake,
  type OpenVikingMcpServerConfig,
} from "./mcpProxy.js";
import { type IOpenVikingService, type OpenVikingVerifyResult } from "./openviking.js";

/**
 * OpenViking 记忆集成服务（本地实现）。
 *
 * 运行时来源 = 安装包内置 `resources/openviking`（dev: 仓库 `vendor/openviking`），
 * hooks 命令与 MCP server 直接指向包内绝对路径，**不再复制**到
 * `<home>/.openviking/agent-integrations/`。26.5.9 前的「复制释放」模式有三个缺陷：
 * ①仅 install 时释放，升级后运行时版本停滞（实测包内 0.5.29、运行时停在 0.5.23）；
 * ②`agent-integrations` 是官方安装器共享目录，官方重跑会覆盖 vendored 适配；
 * ③uninstall 会 rm 该共享目录，误删官方环境。改由启动幂等对账保证配置始终指向当前包路径。
 *
 * 官方安装脚本 install.sh 只支持 macOS/Linux，且渲染的 hook 命令是 POSIX 内联赋值
 * （`VAR='v' node script.mjs`），Windows shell 无法执行，因此本服务自行装配并把命令
 * 改写为 Windows 形式。
 */

const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "Stop"] as const;
const VERIFY_TIMEOUT_MS = 8000;
const logger = createServiceLogger("openviking");

function openVikingHome(): string {
  return process.env.OPENVIKING_HOME?.trim() || path.join(os.homedir(), ".openviking");
}

function connectionFilePath(): string {
  return path.join(openVikingHome(), "ovcli.conf");
}

/** CLI 配置路径。CLI 侧的 DEFAULT_BASE_DIR 固定为 ~/.yazcode/cli，不受数据根重定向影响。 */
function cliConfigPath(): string {
  return path.join(os.homedir(), ".yazcode", "cli", "config.json");
}

/**
 * 安装包内置运行时位置。
 *
 * 生产环境由宿主给出 <resources>/openviking；开发态从 cwd 逐级上溯找仓库
 * vendor/openviking。这里刻意不用 __dirname / import.meta 推导：服务被 ESM 与
 * CJS 两种加载方式引用过，模块元数据在 top-level await 场景下不可用。
 * 两者都找不到时返回空串，由调用方 fail-closed 报错或跳过对账。
 */
function resolvePackagedRuntimeRoot(): string {
  const isRuntimeRoot = (candidate: string): boolean =>
    fs.existsSync(path.join(candidate, "zcode", "scripts", "hook.mjs")) &&
    fs.existsSync(path.join(candidate, "memory-plugin-shared", "lib", "MANIFEST"));

  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    const packaged = path.join(resourcesPath, "openviking");
    if (isRuntimeRoot(packaged)) return packaged;
  }
  let dir = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(dir, "vendor", "openviking");
    if (isRuntimeRoot(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "";
}

/** 包内 zcode host 目录（hooks/MCP 装配根）。缺失时抛错——install 与握手路径使用。 */
function packagedHostRootOrThrow(): string {
  const root = resolvePackagedRuntimeRoot();
  if (!root) {
    throw new Error(
      "OpenViking 运行时缺失：安装包内未找到 vendor/openviking，无法启用该记忆提供方。",
    );
  }
  return path.join(root, "zcode");
}

/** 包内 integration.json 的版本锚点（与 vendored 版本一致，当前 0.5.31）。 */
function readPackagedIntegrationVersion(runtimeRoot: string): string | undefined {
  const integration = readJsonFile(
    path.join(runtimeRoot, "zcode", "hosts", "zcode", "openviking.integration.json"),
  );
  const version = integration.version;
  return typeof version === "string" ? version : undefined;
}

/** 引号感知切分：路径可能含空格，不能按空白硬拆。 */
function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

/**
 * 把官方 POSIX 内联赋值的 hook 命令改写为 Windows 可执行形式：
 *   VAR1='v1' node script.mjs arg   →   set "VAR1=v1" && node script.mjs arg
 * 只有 set 链用 &&；可执行文件与其参数同属一条命令，必须用空格分隔。
 */
function rewriteHookCommandForWindows(command: string): string {
  const withoutComment = command.replace(/\s+#\s*openviking-memory\s*$/u, "").trim();
  const vars: string[][] = [];
  let rest = withoutComment;
  for (;;) {
    const match = /^([A-Z_][A-Z0-9_]*)='([^']*)'\s+/u.exec(rest);
    if (!match) break;
    vars.push([match[1] ?? "", match[2] ?? ""]);
    rest = rest.slice(match[0].length);
  }
  const parts = tokenizeCommand(rest).map((part) => (/\s/.test(part) ? `"${part}"` : part));
  const setChain = vars.map(([name, value]) => `set "${name}=${value}"`).join(" && ");
  return setChain ? `${setChain} && ${parts.join(" ")}` : parts.join(" ");
}

/**
 * 官方 host 模板渲染。
 *
 * `__OPENVIKING_PLUGIN_ROOT__` 指的是 **zcode host 目录本身**（<runtime>/zcode），
 * 不是 agent-integrations 根——官方 installer 就是这么传的。模板命令不带环境变量前缀，
 * 前缀由官方 write 阶段追加；这里按同样语义补上 POSIX 形式，再交给
 * rewriteHookCommandForWindows 转成 Windows 可执行形式。
 */
function renderHooks(hostRoot: string, integrationVersion: string): Record<string, unknown> {
  const templatePath = path.join(hostRoot, "hosts", "zcode", "hooks.json");
  const template = JSON.parse(fs.readFileSync(templatePath, "utf8")) as {
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>>;
  };
  const envPrefix = [
    ["OPENVIKING_INTEGRATION_ID", INTEGRATION_ID],
    ["OPENVIKING_INTEGRATION_VERSION", integrationVersion],
    ["OPENVIKING_HOOK_SOURCE", "zcode"],
  ]
    .map(([name, value]) => `${name}='${value}'`)
    .join(" ");
  const rendered: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(template.hooks)) {
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) continue;
    rendered[event] = groups.map((group) => ({
      ...(group.matcher === undefined ? {} : { matcher: group.matcher }),
      hooks: (group.hooks ?? []).map((hook) => {
        const command = String(hook.command ?? "")
          .replaceAll("__OPENVIKING_PLUGIN_ROOT__", hostRoot.replace(/\\/gu, "/"))
          .replaceAll("__OPENVIKING_CLIENT_ID__", "zcode")
          .trim();
        return {
          type: "command",
          command: rewriteHookCommandForWindows(`${envPrefix} ${command}`),
          timeout: hook.timeout,
        };
      }),
    }));
  }
  return rendered;
}

function readJsonFile(file: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeJsonFile(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** 连接文件是 JSON（官方 credentials.mjs 以 tryLoadJson 读）；已存在则先备份。 */
function writeConnectionFile(params: { url: string; userKey: string }): void {
  const target = connectionFilePath();
  const existing = readJsonFile(target);
  if (fs.existsSync(target)) {
    fs.copyFileSync(target, `${target}.bak.${new Date().toISOString().replace(/[:.]/gu, "-")}`);
  }
  writeJsonFile(target, { ...existing, url: params.url, api_key: params.userKey });
}

/** 合并 hooks 与 MCP 到 CLI 配置。官方 merge-zcode 的行为：置 hooks.enabled 并并入两段。 */
function mergeCliConfig(hooks: Record<string, unknown>, hostRoot: string): void {
  const configPath = cliConfigPath();
  const config = readJsonFile(configPath);
  const mcp = readJsonFile(path.join(hostRoot, "hosts", "zcode", ".mcp.json"));
  const serverTemplate = (mcp.mcpServers ?? {}) as Record<string, Record<string, unknown>>;
  const openvikingServer = serverTemplate.openviking;
  if (!openvikingServer) {
    throw new Error("OpenViking 运行时缺少 MCP 模板（hosts/zcode/.mcp.json）。");
  }

  const mcpSection = (config.mcp ?? {}) as Record<string, unknown>;
  const servers = (mcpSection.servers ?? {}) as Record<string, unknown>;
  servers.openviking = buildOpenVikingMcpServerConfig(
    process.execPath,
    path.join(hostRoot, "servers", "mcp-proxy.mjs"),
  );
  config.mcp = { ...mcpSection, servers };

  config.hooks = {
    ...((config.hooks ?? {}) as Record<string, unknown>),
    enabled: true,
    events: hooks,
  };
  writeJsonFile(configPath, config);
}

/**
 * CLI 配置里的 openviking 段是否指向给定 host 根。
 * hooks 与 MCP 必须同时指向（spec 约束 4：二者同进同出，不允许半开状态）；
 * 路径比较统一正斜杠（渲染时已把 Windows 反斜杠转正斜杠）。
 */
function configPointsAt(hostRoot: string): boolean {
  const normalizedRoot = hostRoot.replace(/\\/gu, "/");
  const config = readJsonFile(cliConfigPath());
  const hooksText = JSON.stringify(config.hooks ?? {});
  if (!hooksText.includes(normalizedRoot) || !hooksText.includes("openviking")) return false;
  const servers = (config.mcp as { servers?: Record<string, OpenVikingMcpServerConfig> } | undefined)
    ?.servers;
  const entry = servers?.openviking;
  if (!entry || !Array.isArray(entry.args)) return false;
  const expected = path.join(hostRoot, "servers", "mcp-proxy.mjs").replace(/\\/gu, "/");
  const actual = typeof entry.args[0] === "string" ? entry.args[0].replace(/\\/gu, "/") : "";
  return actual === expected;
}

/** 读回 CLI 配置里落盘的 openviking MCP 条目——握手自检以磁盘真值为准。 */
function readInstalledMcpServer(): OpenVikingMcpServerConfig {
  const config = readJsonFile(cliConfigPath());
  const mcp = config.mcp as Record<string, unknown> | undefined;
  const servers = mcp?.servers as Record<string, unknown> | undefined;
  const entry = servers?.openviking as OpenVikingMcpServerConfig | undefined;
  if (!entry || typeof entry.command !== "string" || !Array.isArray(entry.args)) {
    throw new Error("CLI 配置缺少 openviking MCP 条目。");
  }
  return entry;
}

/** 从 CLI 配置里摘掉 openviking 的 hooks 段与 MCP server，其余配置不动。 */
function removeIntegrationFromCliConfig(): void {
  const configPath = cliConfigPath();
  if (!fs.existsSync(configPath)) return;
  const config = readJsonFile(configPath);

  const hooks = config.hooks as Record<string, unknown> | undefined;
  if (hooks?.events && typeof hooks.events === "object") {
    const events = hooks.events as Record<
      string,
      Array<{ hooks?: Array<Record<string, unknown>> }>
    >;
    for (const [event, groups] of Object.entries(events)) {
      const kept = (groups ?? [])
        .map((group) => ({
          ...group,
          hooks: (group.hooks ?? []).filter((hook) => !JSON.stringify(hook).includes("openviking")),
        }))
        .filter((group) => (group.hooks ?? []).length > 0);
      if (kept.length === 0) delete events[event];
      else events[event] = kept;
    }
  }

  const mcp = config.mcp as Record<string, unknown> | undefined;
  const servers = mcp?.servers as Record<string, unknown> | undefined;
  if (servers?.openviking) {
    delete servers.openviking;
    if (Object.keys(servers).length === 0) delete config.mcp;
  }
  writeJsonFile(configPath, config);
}

async function fetchHealth(
  url: string,
  headers: Record<string, string>,
): Promise<OpenVikingVerifyResult> {
  const base = url.replace(/\/+$/u, "");
  let response: Response;
  try {
    response = await fetch(`${base}/health`, {
      headers,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch {
    return {
      ok: false,
      reason: "unreachable",
      message: `无法连接到 ${base}，请检查服务地址与网络可达性。`,
    };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      reason: "unauthorized",
      message: "密钥无效或无记忆读写权限。注意必须使用 user key：root key 只能用于管理面。",
    };
  }
  if (!response.ok) {
    return { ok: false, reason: "server_error", message: `服务返回 ${response.status}。` };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "not_openviking", message: "该地址的 /health 响应不是 OpenViking 服务。" };
  }
  const payload = body as { healthy?: boolean; version?: string };
  if (!payload?.healthy) {
    return { ok: false, reason: "not_openviking", message: "该地址不是健康的 OpenViking 服务。" };
  }
  return { ok: true, version: payload.version };
}

/** 校验鉴权是否真的能读记忆：/health 是公开的，需要一个数据面请求才能确认 user key 有效。 */
async function verifyDataAccess(url: string, userKey: string): Promise<OpenVikingVerifyResult> {
  const base = url.replace(/\/+$/u, "");
  const headers = { "x-api-key": userKey };
  try {
    const response = await fetch(`${base}/api/v1/fs/ls?uri=viking://`, {
      headers,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        reason: "unauthorized",
        message: "密钥无法访问记忆数据。请使用 user key，root key 仅支持管理面操作。",
      };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: "unreachable",
      message: `无法访问 OpenViking 数据面：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function createOpenVikingService(): IOpenVikingService {
  return {
    async verifyConnection({ url, userKey }) {
      const trimmedUrl = url.trim();
      const trimmedKey = userKey.trim();
      if (!trimmedUrl) return { ok: false, reason: "unreachable", message: "服务地址不能为空。" };
      if (!trimmedKey) return { ok: false, reason: "unauthorized", message: "user key 不能为空。" };
      const health = await fetchHealth(trimmedUrl, { "x-api-key": trimmedKey });
      if (!health.ok) return health;
      const access = await verifyDataAccess(trimmedUrl, trimmedKey);
      if (!access.ok) return access;
      return health;
    },

    async install({ url, userKey }) {
      const verification = await this.verifyConnection({ url, userKey });
      if (!verification.ok) {
        throw new Error(verification.message ?? "OpenViking 连接校验未通过。");
      }
      const hostRoot = packagedHostRootOrThrow();
      writeConnectionFile({ url: url.trim(), userKey: userKey.trim() });
      // 半开态防线：写盘后用落盘的 command 真跑一次 MCP 握手；失败回滚 CLI 配置，
      // 不留「hooks 已写、代理拉不起」（2026-10-25 workwin 事故形态，见 spec）。
      const configPath = cliConfigPath();
      const previousConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : null;
      mergeCliConfig(renderHooks(hostRoot, INTEGRATION_VERSION), hostRoot);
      try {
        await verifyMcpProxyHandshake(readInstalledMcpServer());
      } catch (error) {
        if (previousConfig === null) fs.rmSync(configPath, { force: true });
        else fs.writeFileSync(configPath, previousConfig, "utf8");
        throw new Error(
          `OpenViking MCP 握手自检未通过，已回滚 CLI 配置：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      // 设置侧把 provider 切到 openviking 前会先跑一次 install；这里再确认配置确实落盘。
      const config = readJsonFile(cliConfigPath());
      if (!JSON.stringify(config).includes("openviking")) {
        throw new Error("OpenViking 配置未能写入 CLI 配置文件。");
      }
      const runtimeRoot = resolvePackagedRuntimeRoot();
      return {
        installed: true,
        version: runtimeRoot ? readPackagedIntegrationVersion(runtimeRoot) : INTEGRATION_VERSION,
        source: "packaged",
      };
    },

    async uninstall() {
      // 只移除 CLI 配置段：~/.openviking/agent-integrations/ 归官方安装器域，不写不删；
      // ovcli.conf 含用户凭据，卸载不删除，只解除配置引用。
      removeIntegrationFromCliConfig();
    },

    async getStatus() {
      const runtimeRoot = resolvePackagedRuntimeRoot();
      if (!runtimeRoot) return { installed: false };
      const hostRoot = path.join(runtimeRoot, "zcode");
      if (!configPointsAt(hostRoot)) return { installed: false };
      return {
        installed: true,
        version: readPackagedIntegrationVersion(runtimeRoot),
        source: "packaged",
      };
    },

    /**
     * 启动幂等对账：CLI 配置存在 openviking 段但插件根不是当前包路径时重写。
     * 覆盖三类漂移：升级/换安装目录后的路径失效、被官方安装器改写、旧复制释放模式的存量配置。
     * 未启用（无 openviking 段）时 no-op；包内运行时缺失时拒绝改动（fail-closed：
     * 宁可保留旧配置，也不把配置指向不存在的路径）。不握手——启动期不引子进程自检。
     */
    async reconcileStartup() {
      const runtimeRoot = resolvePackagedRuntimeRoot();
      if (!runtimeRoot) {
        logger.warn("OpenViking 运行时缺失，跳过启动对账");
        return;
      }
      const hostRoot = path.join(runtimeRoot, "zcode");
      if (!isIntegrationConfigured()) return;
      if (configPointsAt(hostRoot)) return;
      mergeCliConfig(renderHooks(hostRoot, INTEGRATION_VERSION), hostRoot);
      logger.info("OpenViking 集成已对账到包内运行时", { hostRoot });
    },
  };
}

/** 供测试与设置页复用：CLI 配置里当前是否已装载 openviking 段。 */
export function isIntegrationConfigured(): boolean {
  return JSON.stringify(readJsonFile(cliConfigPath())).includes("openviking");
}
