/**
 * IAB 用户脚本静态规则（纯函数，无 IO / 无 electron / 无 node 依赖）：
 * userscript header 解析与 @match pattern 判定的唯一实现。消费者：
 * - desktop main/preload（经 `userscriptRules.ts` re-export，spec 接口节）；
 * - UI 编辑器的输入时即时校验（26.5.4 S2，`validateUserscriptHeaderDraft`）——
 *   保证「输入时所见 = 保存后扫描所得」，不复制规则。
 * 契约见 docs/specs/iab-userscripts.md 行为规则 4 与 P4 行为规则 5b。
 */

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

/**
 * 非法 @match pattern 的可执行诊断（26.5.4 S2）：与 compileMatchPattern 的失败
 * 分支一一对应、同序判定（path 通配 → 端口 → 通配符位置），保证「explain 说没问题
 * ⇔ compile 会通过」。合法 pattern 返回 null。
 * port_host 携带 best-effort 的裸 host 改写建议（端口剥除；IPv6 字面量剥到 `]`）。
 */
export type MatchPatternProblem =
  | { kind: "invalid_format" }
  | { kind: "port_host"; suggestion: string }
  | { kind: "bad_wildcard" }
  | { kind: "too_many_path_wildcards"; limit: number };

export function explainMatchPatternProblem(pattern: string): MatchPatternProblem | null {
  const trimmed = pattern.trim();
  if (trimmed === "<all_urls>") return null;
  const parsed = /^(\*|https?):\/\/([^/]*)(\/.*)$/.exec(trimmed);
  if (!parsed) return { kind: "invalid_format" };
  // noUncheckedIndexedAccess：捕获组按可能缺席处理。
  const scheme = parsed[1];
  const rawHost = parsed[2];
  const rawPath = parsed[3];
  if (!scheme || !rawHost || !rawPath) return { kind: "invalid_format" };
  if (rawPath.split("*").length - 1 > MAX_MATCH_PATTERN_PATH_WILDCARDS) {
    return { kind: "too_many_path_wildcards", limit: MAX_MATCH_PATTERN_PATH_WILDCARDS };
  }
  const host = rawHost.toLowerCase();
  if (host.includes(":")) {
    // best-effort 剥端口建议：IPv6 字面量保方括号只剥端口。注意本规则下 host 内
    // 任何冒号都拒绝（行为规则 4），裸 IPv6 字面量同样不在支持面——建议只完成
    // 「剥端口」这一步可执行动作，其余由扫描 fail-closed 与提示文案通用说明承接。
    const bracketEnd = rawHost.indexOf("]");
    const bareHost =
      rawHost.startsWith("[") && bracketEnd !== -1
        ? rawHost.slice(0, bracketEnd + 1)
        : rawHost.slice(0, rawHost.indexOf(":"));
    return {
      kind: "port_host",
      suggestion: `${scheme}://${bareHost || "<host>"}${rawPath}`,
    };
  }
  if (host === "*") return null;
  if (host.startsWith("*.")) {
    const suffix = host.slice(2);
    if (!suffix || suffix.includes("*")) return { kind: "bad_wildcard" };
    return null;
  }
  if (host.includes("*")) return { kind: "bad_wildcard" };
  return null;
}

/**
 * 草稿级 header 校验（26.5.4 S2，编辑器输入时调用）：元数据块缺失 / @match 缺失 /
 * 逐 pattern 诊断。只覆盖扫描拒载的静态原因（run-at / grant 的白名单判定在
 * desktop 侧 rules，编辑器草稿不重复——保存后扫描仍 fail-closed 承接全部语义）。
 */
export type UserscriptDraftProblem =
  | { kind: "metadata_missing" }
  | { kind: "match_missing" }
  | { kind: "pattern"; pattern: string; problem: MatchPatternProblem };

export function validateUserscriptHeaderDraft(code: string): UserscriptDraftProblem[] {
  const header = parseUserScriptHeader(code);
  if (!header) return [{ kind: "metadata_missing" }];
  const problems: UserscriptDraftProblem[] = [];
  if (header.matchPatterns.length === 0) {
    problems.push({ kind: "match_missing" });
  }
  for (const pattern of header.matchPatterns) {
    const problem = explainMatchPatternProblem(pattern);
    if (problem) problems.push({ kind: "pattern", pattern, problem });
  }
  return problems;
}
