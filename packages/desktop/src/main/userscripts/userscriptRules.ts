/**
 * 用户脚本静态规则（纯函数，无 IO / 无 electron / 无 node 依赖）：
 * main 侧 store 与 guest 侧 preload runtime 共用，保证两侧对「可注入」的判定同源。
 * 契约见 docs/specs/iab-userscripts.md。
 *
 * header 解析与 @match 编译/诊断的唯一实现在 shared（`@zcode/shared/userscriptRules`，
 * 26.5.4 S2 起 UI 编辑器输入校验同源复用，不复制规则）；本模块保留 desktop 侧
 * 专属规则（run-at / grant / URL 匹配 / 构建与 id 校验）并 re-export 共享面，
 * 既有 import 路径（含 runtime 的 `../main/userscripts/userscriptRules.js`）不变。
 */

import {
  compileMatchPattern,
  MAX_MATCH_PATTERN_PATH_WILDCARDS,
  parseUserScriptHeader,
} from "@zcode/shared/userscriptRules";

// 共享面 re-export（不产生局部绑定，供既有引用路径使用）；上方 import 仅供本模块
// buildUserScriptDef 使用。
export {
  MAX_MATCH_PATTERN_PATH_WILDCARDS,
  compileMatchPattern,
  explainMatchPatternProblem,
  parseUserScriptHeader,
  validateUserscriptHeaderDraft,
  type MatchPatternProblem,
  type UserScriptHeaderFields,
  type UserscriptDraftProblem,
} from "@zcode/shared/userscriptRules";

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

/**
 * 脚本 ID 长度上限（P4 红线 4）：scriptId 直接拼进文件名与存储文件名，
 * 上限防异常长名制造超长路径。与 spec 验收场景 5 的「超长 id」拒绝对应。
 */
export const USER_SCRIPT_ID_MAX_LENGTH = 64;

/**
 * 脚本 ID 合法性（P4 红线 4，路径边界的第一道门）：
 * 无路径分隔符、非 `.`/`..` 段、无 Windows 非法字符（`< > : " | ? *`，其中 `:` 还会
 * 撞盘符与 NTFS ADS 语法）、无控制字符、不以 `.` 开头（隐藏文件/相对路径形态）、
 * 不以空格或点结尾（Windows 会静默吞掉尾随空格与点）、长度 ≤64。
 * 唯一实现：userscriptStorage（GM 存储文件名）与 userscriptFiles（写盘通道）共用，
 * 不复制规则（P4 行为规则 3）。store 扫描出的 scriptId 来自磁盘文件名 stem，
 * 天然满足本规则；校验是防未来调用面变化的纵深防御。
 */
export function isValidUserScriptId(scriptId: string): boolean {
  if (typeof scriptId !== "string") return false;
  if (scriptId.length === 0 || scriptId.length > USER_SCRIPT_ID_MAX_LENGTH) return false;
  // 无分隔符时整串就是唯一路径段；`/`、`\` 与 dot 段一并拒绝即挡住路径穿越（m2-6 规则的超集）。
  if (scriptId.includes("/") || scriptId.includes("\\")) return false;
  if (scriptId === "." || scriptId === "..") return false;
  for (const ch of '<>:"|?*') {
    if (scriptId.includes(ch)) return false;
  }
  for (const ch of scriptId) {
    const code = ch.codePointAt(0) ?? 0;
    // 控制字符（含 DEL）：跨平台文件名安全。不用控制字符正则，避免 no-control-regex 一类静态检查噪音。
    if (code <= 0x1f || code === 0x7f) return false;
  }
  if (scriptId.startsWith(".")) return false;
  if (scriptId.endsWith(" ") || scriptId.endsWith(".")) return false;
  return true;
}
