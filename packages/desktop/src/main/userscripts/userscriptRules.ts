/**
 * 用户脚本静态规则（纯函数，无 IO / 无 electron / 无 node 依赖）：
 * main 侧 store 与 guest 侧 preload runtime 共用，保证两侧对「可注入」的判定同源。
 * 契约见 docs/specs/iab-userscripts.md。
 */

export type UserScriptRunAt = "document-start" | "document-end" | "document-idle";

/** runtime 只在 http(s) 文档上生效；chrome-error、about:blank 等一律 no-op。 */
export function isInjectableUrlProtocol(protocol: string): boolean {
  return protocol === "http:" || protocol === "https:";
}

export const USER_SCRIPT_RUN_AT_VALUES: readonly UserScriptRunAt[] = [
  "document-start",
  "document-end",
  "document-idle",
];

/** 未知值返回 null（调用方按解析失败处理），不静默降级。 */
export function normalizeRunAt(value: unknown): UserScriptRunAt | null {
  if (typeof value !== "string") return null;
  const lowered = value.trim().toLowerCase();
  return (USER_SCRIPT_RUN_AT_VALUES as readonly string[]).includes(lowered)
    ? (lowered as UserScriptRunAt)
    : null;
}

/**
 * P1 GM 面白名单。声明白名单之外的 grant 整只脚本拒载（fail-closed）；
 * GM_info 恒可用，不在白名单内。
 */
export const USER_SCRIPT_GRANT_WHITELIST: readonly string[] = [
  "GM_addStyle",
  "GM_getValue",
  "GM_setValue",
  "GM_deleteValue",
  "GM_listValues",
];

export interface UserScriptHeaderFields {
  name?: string;
  version?: string;
  namespace?: string;
  author?: string;
  description?: string;
  matchPatterns: string[];
  runAt?: string;
  grants: string[];
}

/** 提取 ==UserScript== 元数据块；块不存在返回 null。 */
export function parseUserScriptHeader(code: string): UserScriptHeaderFields | null {
  const startMatch = /^\s*\/\/\s*==UserScript==\s*$/m.exec(code);
  if (!startMatch) return null;
  const rest = code.slice(startMatch.index + startMatch[0].length);
  const endMatch = /^\s*\/\/\s*==\/UserScript==\s*$/m.exec(rest);
  if (!endMatch) return null;

  const fields: UserScriptHeaderFields = { matchPatterns: [], grants: [] };
  for (const line of rest.slice(0, endMatch.index).split(/\r?\n/)) {
    const entry = /^\s*\/\/\s*@([\w:-]+)\s*(.*)$/.exec(line);
    if (!entry) continue;
    // noUncheckedIndexedAccess：捕获组按可能缺席处理。
    const key = (entry[1] ?? "").toLowerCase();
    const value = (entry[2] ?? "").trim();
    switch (key) {
      case "name":
        fields.name ??= value;
        break;
      case "version":
        fields.version ??= value;
        break;
      case "namespace":
        fields.namespace ??= value;
        break;
      case "author":
        fields.author ??= value;
        break;
      case "description":
        fields.description ??= value;
        break;
      case "match":
        if (value) fields.matchPatterns.push(value);
        break;
      case "run-at":
        fields.runAt ??= value;
        break;
      case "grant":
        if (value) fields.grants.push(value);
        break;
      default:
        break;
    }
  }
  return fields;
}

/**
 * 单 pattern path 段允许的 `*` 数量上限（复核 m2-1）：path 以 `*` 切段后用 `.*` 顺序
 * 量词连接，段数越多 main 进程 URL 匹配的回溯常数越大（实测 8 段 `*` 对 12800 字符
 * URL 已 180ms，且随 URL 长度平方增长）。正常 match pattern 的 path 通配 1-2 个，
 * 8 是宽松上限；超限既非合法用户脚本需要，又放大匹配成本，按解析失败处理
 * （fail-closed，该 pattern 拒载 → 整只脚本不入服务集）。
 */
export const MAX_MATCH_PATTERN_PATH_WILDCARDS = 8;

/**
 * Chrome match pattern 的 http(s) 子集编译为正则。语义要点：
 * - scheme ∈ { http, https, * }（* = http 或 https）；
 * - host 支持精确、`*`（任意）与 `*.example.com`（含自身与子域），host 内其他位置
 *   的 `*` 非法；pattern 不携带端口（URL 端口在匹配时被忽略，与 Chrome 一致）；
 * - path 以 `/` 开头，`*` 匹配任意字符（含 `/`），匹配对象是 pathname + search；
 *   单 pattern path 段的 `*` 数量超过 MAX_MATCH_PATTERN_PATH_WILDCARDS 视为非法
 *   （防 main 进程多项式回溯，复核 m2-1）；
 * - `<all_urls>` 等价 scheme 通配 + 任意 host 与 path，仍限定 http(s)。
 * 非法 pattern 返回 null（该脚本拒载），不做容错修正。
 */
export function compileMatchPattern(pattern: string): RegExp | null {
  const trimmed = pattern.trim();
  if (trimmed === "<all_urls>") return /^https?:\/\/[^/]*\/.*$/;
  const parsed = /^(\*|https?):\/\/([^/]*)(\/.*)$/.exec(trimmed);
  if (!parsed) return null;
  // noUncheckedIndexedAccess：捕获组按可能缺席处理。
  const scheme = parsed[1];
  const rawHost = parsed[2];
  const rawPath = parsed[3];
  if (!scheme || !rawHost || !rawPath) return null;
  if (rawPath.split("*").length - 1 > MAX_MATCH_PATTERN_PATH_WILDCARDS) return null;
  const host = rawHost.toLowerCase();
  // pattern 不携带端口（含 IPv6 字面量的冒号）；URL 端口在匹配时被剥离，作者应写裸 host。
  if (host.includes(":")) return null;
  let hostPattern: string;
  if (host === "*") {
    hostPattern = "[^/]*";
  } else if (host.startsWith("*.")) {
    const suffix = escapeRegExp(host.slice(2));
    if (!suffix || suffix.includes("*")) return null;
    hostPattern = `(?:[^/]+\\.)?${suffix}`;
  } else {
    if (host.includes("*")) return null;
    hostPattern = escapeRegExp(host);
  }
  const pathPattern = rawPath.split("*").map(escapeRegExp).join(".*");
  const schemePattern = scheme === "*" ? "https?" : scheme;
  return new RegExp(`^${schemePattern}://${hostPattern}${pathPattern}$`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** URL 规范化后与编译 pattern 匹配：端口剥离、path+search 参与、scheme 限定 http(s)。 */
export function urlMatchesCompiledPattern(url: URL, pattern: RegExp): boolean {
  if (!isInjectableUrlProtocol(url.protocol)) return false;
  const canonical = `${url.protocol.replace(":", "")}://${url.hostname}${url.pathname}${url.search}`;
  return pattern.test(canonical);
}

export function urlMatchesAnyPattern(url: URL, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => urlMatchesCompiledPattern(url, pattern));
}

export interface UserScriptGrantResolution {
  ok: boolean;
  grants: string[];
  reason?: string;
}

/** 解析 @grant 列表：`none` 视为空；出现白名单之外的 grant 即拒载。 */
export function resolveUserScriptGrants(rawGrants: readonly string[]): UserScriptGrantResolution {
  const grants: string[] = [];
  for (const raw of rawGrants) {
    for (const token of raw.split(/[\s,]+/)) {
      const grant = token.trim();
      if (!grant || grant.toLowerCase() === "none") continue;
      if (!(USER_SCRIPT_GRANT_WHITELIST as readonly string[]).includes(grant)) {
        return { ok: false, grants: [], reason: `grant not allowed: ${grant}` };
      }
      if (!grants.includes(grant)) grants.push(grant);
    }
  }
  return { ok: true, grants };
}

export interface UserScriptDef {
  scriptId: string;
  name: string;
  version?: string;
  namespace?: string;
  author?: string;
  description?: string;
  runAt: UserScriptRunAt;
  grants: string[];
  /** 声明的原始 @match pattern（P2 状态面回显用）；编译产物见 compiledPatterns。 */
  matchPatterns: string[];
  compiledPatterns: RegExp[];
  code: string;
  sha256: string;
}

export type UserScriptParseResult =
  | { ok: true; def: UserScriptDef }
  | { ok: false; reason: string };

/**
 * 从脚本源码构造可注入定义。任何一步失败都以带原因的拒载结束：
 * 无元数据块 / 缺 @match / 非法 pattern / 未知 run-at / 白名单外 grant。
 */
export function buildUserScriptDef(input: {
  scriptId: string;
  code: string;
  sha256: string;
  fallbackName: string;
}): UserScriptParseResult {
  // 剥掉 UTF-8 BOM：否则首行的 ==UserScript== 起始标记匹配不到（BOM 不属于 \s）。
  const code = input.code.replace(/^\uFEFF/, "");
  const header = parseUserScriptHeader(code);
  if (!header) return { ok: false, reason: "metadata block missing" };
  if (header.matchPatterns.length === 0) {
    return { ok: false, reason: "@match missing" };
  }
  const compiledPatterns: RegExp[] = [];
  for (const pattern of header.matchPatterns) {
    const compiled = compileMatchPattern(pattern);
    if (!compiled) return { ok: false, reason: `invalid @match pattern: ${pattern}` };
    compiledPatterns.push(compiled);
  }
  const runAt = header.runAt ? normalizeRunAt(header.runAt) : "document-start";
  if (!runAt) {
    return { ok: false, reason: `unknown @run-at: ${header.runAt}` };
  }
  const grantResolution = resolveUserScriptGrants(header.grants);
  if (!grantResolution.ok) {
    return { ok: false, reason: grantResolution.reason ?? "grant rejected" };
  }
  return {
    ok: true,
    def: {
      scriptId: input.scriptId,
      name: header.name || input.fallbackName,
      ...(header.version ? { version: header.version } : {}),
      ...(header.namespace ? { namespace: header.namespace } : {}),
      ...(header.author ? { author: header.author } : {}),
      ...(header.description ? { description: header.description } : {}),
      runAt,
      grants: grantResolution.grants,
      matchPatterns: [...header.matchPatterns],
      compiledPatterns,
      code,
      sha256: input.sha256,
    },
  };
}

/** GM 存储 key 上限：防止异常脚本撑爆存储文件。 */
export const USER_SCRIPT_STORAGE_KEY_MAX_LENGTH = 512;

export function isValidStorageKey(key: unknown): key is string {
  return (
    typeof key === "string" && key.length > 0 && key.length <= USER_SCRIPT_STORAGE_KEY_MAX_LENGTH
  );
}
