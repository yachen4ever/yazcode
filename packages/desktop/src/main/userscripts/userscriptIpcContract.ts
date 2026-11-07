/**
 * 用户脚本 IPC 契约：channel 名与 wire 类型，main 侧 handler 与 guest 侧
 * preload runtime 共用（纯模块，无 IO / 无 electron）。
 *
 * 恰好 4 个 channel（契约约束，禁止进一步扩张；26.5.4 S1 起含执行回执，见 spec
 * docs/specs/iab-userscripts.md 行为规则 6/9）：
 * - match（invoke）：按 URL 拉取当前可注入脚本；
 * - get（sendSync）：GM_getValue / GM_listValues；
 * - set（sendSync）：GM_setValue / GM_deleteValue；
 * - report（send，fire-and-forget）：runtime 逐脚本回执同步执行结果（executed/failed）。
 * get/set 走 sendSync 是为了保持 Tampermonkey 的同步语义与 set→get 顺序。
 * 回包永远不包含脚本文件路径。
 */

export const USERSCRIPT_IPC_CHANNELS = {
  match: "zcode:userscripts:match",
  get: "zcode:userscripts:get",
  set: "zcode:userscripts:set",
  report: "zcode:userscripts:report",
} as const;

export interface UserScriptMatchRequest {
  url: string;
}

export interface UserScriptMatchItem {
  scriptId: string;
  name: string;
  runAt: string;
  grants: string[];
  version?: string;
  namespace?: string;
  code: string;
}

export interface UserScriptMatchResponse {
  scripts: UserScriptMatchItem[];
}

export type UserScriptStorageGetRequest =
  | { kind: "get"; scriptId: string; key: string }
  | { kind: "list"; scriptId: string };

export type UserScriptStorageSetRequest =
  | { kind: "put"; scriptId: string; key: string; value: unknown }
  | { kind: "delete"; scriptId: string; key: string };

/**
 * 执行回执（26.5.4 S1，report channel）：runtime 对每只脚本同步执行完成后回执。
 * failed 携带错误摘要（runtime 侧已截断）；成功不携带 message。
 */
export type UserScriptExecutionReport =
  | { kind: "executed"; scriptId: string }
  | { kind: "failed"; scriptId: string; message: string };

/** 回执 message 上限：异常脚本不得用超长错误刷内存表（超出截断，不拒绝）。 */
export const USER_SCRIPT_REPORT_MESSAGE_MAX_LENGTH = 500;

/** report 入参守卫：形状或 scriptId 非法返回 null（main 侧忽略不记）。 */
export function parseExecutionReport(payload: unknown): UserScriptExecutionReport | null {
  if (!isPlainRecord(payload)) return null;
  const scriptId = payload.scriptId;
  if (typeof scriptId !== "string" || scriptId.length === 0) return null;
  const truncate = (value: unknown): string =>
    String(value).slice(0, USER_SCRIPT_REPORT_MESSAGE_MAX_LENGTH);
  if (payload.kind === "executed") return { kind: "executed", scriptId };
  if (payload.kind === "failed" && typeof payload.message === "string") {
    return { kind: "failed", scriptId, message: truncate(payload.message) };
  }
  return null;
}

export interface UserScriptStorageResult {
  ok: boolean;
  /** get 命中时的值；list 命中时的键列表。失败时缺省。 */
  value?: unknown;
  keys?: string[];
  error?: UserScriptStorageErrorCode;
}

export type UserScriptStorageErrorCode =
  | "invalid_request"
  | "unknown_script"
  | "invalid_key"
  | "invalid_value"
  | "sub_frame_denied"
  | "storage_limit"
  | "storage_corrupt"
  | "storage_error";

export function isUserScriptStorageErrorCode(value: unknown): value is UserScriptStorageErrorCode {
  return (
    value === "invalid_request" ||
    value === "unknown_script" ||
    value === "invalid_key" ||
    value === "invalid_value" ||
    value === "sub_frame_denied" ||
    value === "storage_limit" ||
    value === "storage_corrupt" ||
    value === "storage_error"
  );
}

/** match 入参守卫：url 必须是可注入协议（http/https）的绝对 URL，否则整个请求无效。 */
export function parseMatchRequestUrl(payload: unknown): URL | null {
  if (typeof payload !== "object" || payload === null) return null;
  const url = (payload as { url?: unknown }).url;
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStorageValueSerializable(value: unknown): boolean {
  // undefined / 函数 / 循环引用都不是合法 GM 存储值：JSON.stringify 对 undefined
  // 与函数都返回 undefined（不抛错），因此必须检查序列化结果而不是入参本身。
  try {
    return JSON.stringify(value) !== undefined;
  } catch {
    return false;
  }
}

export function parseStorageGetRequest(payload: unknown): UserScriptStorageGetRequest | null {
  if (!isPlainRecord(payload)) return null;
  const scriptId = payload.scriptId;
  if (typeof scriptId !== "string" || scriptId.length === 0) return null;
  if (payload.kind === "list") return { kind: "list", scriptId };
  if (payload.kind === "get" && typeof payload.key === "string" && payload.key.length > 0) {
    return { kind: "get", scriptId, key: payload.key };
  }
  return null;
}

export function parseStorageSetRequest(payload: unknown): UserScriptStorageSetRequest | null {
  if (!isPlainRecord(payload)) return null;
  const scriptId = payload.scriptId;
  if (typeof scriptId !== "string" || scriptId.length === 0) return null;
  if (payload.kind === "delete" && typeof payload.key === "string" && payload.key.length > 0) {
    return { kind: "delete", scriptId, key: payload.key };
  }
  if (
    payload.kind === "put" &&
    typeof payload.key === "string" &&
    payload.key.length > 0 &&
    isStorageValueSerializable(payload.value)
  ) {
    return { kind: "put", scriptId, key: payload.key, value: payload.value };
  }
  return null;
}
