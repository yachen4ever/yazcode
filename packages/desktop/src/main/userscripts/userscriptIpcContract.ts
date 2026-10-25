/**
 * 用户脚本 IPC 契约：channel 名与 wire 类型，main 侧 handler 与 guest 侧
 * preload runtime 共用（纯模块，无 IO / 无 electron）。
 *
 * 恰好 3 个 channel（契约约束，禁止扩张面）：
 * - match（invoke）：按 URL 拉取当前可注入脚本；
 * - get（sendSync）：GM_getValue / GM_listValues；
 * - set（sendSync）：GM_setValue / GM_deleteValue。
 * get/set 走 sendSync 是为了保持 Tampermonkey 的同步语义与 set→get 顺序。
 * 回包永远不包含脚本文件路径。
 */

export const USERSCRIPT_IPC_CHANNELS = {
  match: "zcode:userscripts:match",
  get: "zcode:userscripts:get",
  set: "zcode:userscripts:set",
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
