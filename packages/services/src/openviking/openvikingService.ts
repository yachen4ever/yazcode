import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getZCodeDataRootDir } from "../paths.js";
import {
  type IOpenVikingService,
  type OpenVikingVerifyResult,
} from "./openviking.js";

/**
 * OpenViking 记忆集成服务（本地实现）。
 *
 * 运行时来源是安装包内置的 `vendor/openviking`（Apache-2.0），安装时释放到
 * <home>/.openviking/agent-integrations/。官方安装脚本 install.sh 只支持
 * macOS/Linux，且渲染的 hook 命令是 POSIX 内联赋值（`VAR='v' node script.mjs`），
 * Windows shell 无法执行，因此本服务自行装配并把命令改写为 Windows 形式。
 */

const AGENT_INTEGRATION_DIRS = ["zcode", "memory-plugin-shared"] as const;
const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "Stop"] as const;
const VERIFY_TIMEOUT_MS = 8000;

function openVikingHome(): string {
  return process.env.OPENVIKING_HOME?.trim() || path.join(os.homedir(), ".openviking");
}

function agentIntegrationsRoot(): string {
  return path.join(openVikingHome(), "agent-integrations");
}

function connectionFilePath(): string {
  return path.join(openVikingHome(), "ovcli.conf");
}

/** CLI 配置路径。CLI 侧的 DEFAULT_BASE_DIR 固定为 ~/.yazcode/cli，不受数据根重定向影响。 */
function cliConfigPath(): string {
  return path.join(os.homedir(), ".yazcode", "cli", "config.json");
}

function dataRootV2Dir(): string {
  return path.join(getZCodeDataRootDir(), "v2");
}

/** 安装包内置运行时位置：打包后为 <resources>/openviking，开发态回退到仓库 vendor/。 */
function resolvePackagedRuntimeRoot(): string {
  const candidates: string[] = [];
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) candidates.push(path.join(resourcesPath, "openviking"));
  // electron 未启动（如单测/CLI 场景）时按应用目录向上回退找仓库 vendor。
  candidates.push(path.resolve(__dirname, "..", "..", "..", "vendor", "openviking"));
  candidates.push(path.resolve(process.cwd(), "vendor", "openviking"));
  for (const candidate of candidates) {
    if (
      fs.existsSync(path.join(candidate, "zcode", "scripts", "hook.mjs")) &&
      fs.existsSync(path.join(candidate, "memory-plugin-shared", "lib", "MANIFEST"))
    ) {
      return candidate;
    }
  }
  return "";
}

function copyDir(source: string, destination: string): void {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

/** 释放内置运行时。两个目录必须同级部署：adapter 以 ../../memory-plugin-shared 相对引用。 */
function releaseRuntime(): void {
  const source = resolvePackagedRuntimeRoot();
  if (!source) {
    throw new Error(
      "OpenViking 运行时缺失：安装包内未找到 vendor/openviking，无法启用该记忆提供方。",
    );
  }
  const targetRoot = agentIntegrationsRoot();
  for (const name of AGENT_INTEGRATION_DIRS) {
    const from = path.join(source, name);
    const to = path.join(targetRoot, name);
    const staging = `${to}.tmp`;
    fs.rmSync(staging, { recursive: true, force: true });
    copyDir(from, staging);
    // integration.json 记录本机安装时刻，随运行时一起落盘供 doctor 使用。
    fs.writeFileSync(
      path.join(staging, "integration.json"),
      `${JSON.stringify({ installedAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
    fs.rmSync(to, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(staging, to);
  }
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

/** 官方 host 模板：命令里的插件根与客户端 id 是占位符，安装时替换为绝对路径。 */
function renderHooks(root: string): Record<string, unknown> {
  const templatePath = path.join(root, "zcode", "hosts", "zcode", "hooks.json");
  const template = JSON.parse(fs.readFileSync(templatePath, "utf8")) as {
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>>;
  };
  const rendered: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(template.hooks)) {
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) continue;
    rendered[event] = groups.map((group) => ({
      ...(group.matcher === undefined ? {} : { matcher: group.matcher }),
      hooks: (group.hooks ?? []).map((hook) => {
        const command = String(hook.command ?? "")
          .replaceAll("__OPENVIKING_PLUGIN_ROOT__", root.replace(/\\/gu, "/"))
          .replaceAll("__OPENVIKING_CLIENT_ID__", "zcode")
          .trim();
        return {
          type: "command",
          command: rewriteHookCommandForWindows(command),
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
function mergeCliConfig(hooks: Record<string, unknown>): void {
  const configPath = cliConfigPath();
  const config = readJsonFile(configPath);
  const mcp = readJsonFile(path.join(agentIntegrationsRoot(), "zcode", "hosts", "zcode", ".mcp.json"));
  const serverTemplate = (mcp.mcpServers ?? {}) as Record<string, Record<string, unknown>>;
  const openvikingServer = serverTemplate.openviking;
  if (!openvikingServer) {
    throw new Error("OpenViking 运行时缺少 MCP 模板（hosts/zcode/.mcp.json）。");
  }
  const nodeBin = process.execPath;

  const mcpSection = (config.mcp ?? {}) as Record<string, unknown>;
  const servers = (mcpSection.servers ?? {}) as Record<string, unknown>;
  servers.openviking = {
    command: nodeBin,
    args: [path.join(agentIntegrationsRoot(), "zcode", "servers", "mcp-proxy.mjs")],
    env: {
      OPENVIKING_INTEGRATION_ID: "openviking-memory",
      OPENVIKING_HOOK_SOURCE: "zcode",
    },
  };
  config.mcp = { ...mcpSection, servers };

  config.hooks = {
    ...((config.hooks ?? {}) as Record<string, unknown>),
    enabled: true,
    events: hooks,
  };
  writeJsonFile(configPath, config);
}

/** 从 CLI 配置里摘掉 openviking 的 hooks 段与 MCP server，其余配置不动。 */
function removeIntegrationFromCliConfig(): void {
  const configPath = cliConfigPath();
  if (!fs.existsSync(configPath)) return;
  const config = readJsonFile(configPath);

  const hooks = config.hooks as Record<string, unknown> | undefined;
  if (hooks?.events && typeof hooks.events === "object") {
    const events = hooks.events as Record<string, Array<{ hooks?: Array<Record<string, unknown>> }>>;
    for (const [event, groups] of Object.entries(events)) {
      const kept = (groups ?? [])
        .map((group) => ({
          ...group,
          hooks: (group.hooks ?? []).filter(
            (hook) => !JSON.stringify(hook).includes("openviking"),
          ),
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

async function fetchHealth(url: string, headers: Record<string, string>): Promise<OpenVikingVerifyResult> {
  const base = url.replace(/\/+$/u, "");
  let response: Response;
  try {
    response = await fetch(`${base}/health`, { headers, signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS) });
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
      message:
        "密钥无效或无记忆读写权限。注意必须使用 user key：root key 只能用于管理面。",
    };
  }
  if (!response.ok) {
    return { ok: false, reason: "server_error", message: `服务返回 ${response.status}。` };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      ok: false,
      reason: "not_openviking",
      message: "该地址的 /health 响应不是 OpenViking 服务。",
    };
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

function readInstalledVersion(): string | undefined {
  try {
    const integration = readJsonFile(
      path.join(agentIntegrationsRoot(), "zcode", "integration.json"),
    );
    const version = integration.version ?? integration.integrationVersion;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
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
      releaseRuntime();
      const root = agentIntegrationsRoot();
      writeConnectionFile({ url: url.trim(), userKey: userKey.trim() });
      mergeCliConfig(renderHooks(root));
      // 设置侧把 provider 切到 openviking 前会先跑一次 install；这里再确认配置确实落盘。
      const config = readJsonFile(cliConfigPath());
      if (!JSON.stringify(config).includes("openviking")) {
        throw new Error("OpenViking 配置未能写入 CLI 配置文件。");
      }
      return { installed: true, version: readInstalledVersion(), source: "packaged" };
    },

    async uninstall() {
      removeIntegrationFromCliConfig();
      for (const name of AGENT_INTEGRATION_DIRS) {
        fs.rmSync(path.join(agentIntegrationsRoot(), name), { recursive: true, force: true });
      }
      // ovcli.conf / ov.conf 含用户凭据，卸载不删除，只解除配置引用。
    },

    async getStatus() {
      const entry = path.join(agentIntegrationsRoot(), "zcode", "scripts", "hook.mjs");
      const manifest = path.join(agentIntegrationsRoot(), "memory-plugin-shared", "lib", "MANIFEST");
      const installed = fs.existsSync(entry) && fs.existsSync(manifest);
      return installed
        ? { installed: true, version: readInstalledVersion(), source: "existing" }
        : { installed: false };
    },
  };
}

/** 供测试与设置页复用：CLI 配置里当前是否已装载 openviking 段。 */
export function isIntegrationConfigured(): boolean {
  return JSON.stringify(readJsonFile(cliConfigPath())).includes("openviking");
}

/** 桌面端设置页读写用的数据根 v2 目录（provider 配置同目录族）。 */
export function settingsDataRootV2Dir(): string {
  return dataRootV2Dir();
}