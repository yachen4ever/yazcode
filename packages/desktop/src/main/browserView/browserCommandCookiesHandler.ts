import type { BrowserCommand, BrowserCommandResult } from "@zcode/shared";
import type { ControlledView } from "./browserCommandTypes.js";

/**
 * cookies 命令：经 guest 的 CDP Storage 域读写当前 browser context 的全量 cookies
 * （含 httpOnly）。page-level attach 时 Storage.getCookies 返回该 partition 的
 * browser context 全量，与「cookies 是 browser 级数据」的语义一致。
 *
 * cookies 是会话凭据级数据：结果只回给调用方，禁止写入日志（本模块不 log 任何
 * cookie 字段）。set 逐条调用以便部分失败可定位（CDP 批量调用是整体成败）。
 */

interface CookieParamLike {
  name: string;
  value: string;
  url?: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

function isCookieParamLike(value: unknown): value is CookieParamLike {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || record.name.length === 0) return false;
  if (typeof record.value !== "string") return false;
  const hasUrl = typeof record.url === "string" && record.url.length > 0;
  const hasDomainPath =
    typeof record.domain === "string" &&
    record.domain.length > 0 &&
    typeof record.path === "string" &&
    record.path.length > 0;
  return hasUrl || hasDomainPath;
}

export async function handleCookies(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: "cookies" }>,
  done: (partial: Omit<BrowserCommandResult, "elapsedMs">) => BrowserCommandResult,
): Promise<BrowserCommandResult> {
  if (command.action.name === "get") {
    const result = (await view.cdp.send("Storage.getCookies")) as {
      cookies?: unknown;
    };
    const cookies = Array.isArray(result?.cookies) ? result.cookies : [];
    return done({ ok: true, value: { cookies } });
  }

  // set：逐条写入（部分失败可定位），CDP 的批量 setCookies 是整体成败。
  const failed: { index: number; name: string; error: string }[] = [];
  let set = 0;
  for (let index = 0; index < command.action.cookies.length; index += 1) {
    const cookie = command.action.cookies[index];
    // 运行时兜底校验（schema 已拦大部分；这里防 mock/手拼请求绕过）。
    if (!isCookieParamLike(cookie)) {
      failed.push({ index, name: String((cookie as { name?: unknown })?.name ?? ""), error: "invalid cookie param" });
      continue;
    }
    try {
      await view.cdp.send("Storage.setCookies", { cookies: [cookie] });
      set += 1;
    } catch (error) {
      failed.push({
        index,
        name: cookie.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return done({ ok: true, value: { set, failed } });
}
