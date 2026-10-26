import type { BrowserCommandResult } from "@zcode/shared";
import type { UserScriptStatusItem } from "../userscripts/userscriptStore.js";

/**
 * IAB 用户脚本三命令的 executor 侧 handler（照 cookies handler 先例；契约见
 * docs/specs/iab-userscripts.md P2）：
 * - userscript_list / userscript_reload：返回只读/重扫后的状态列表（value.scripts）；
 * - userscript_set_enabled：agent 来源确认流——enabled=true 只落 pendingApproval，
 *   enabled=false 直接禁用（降权直达）。
 * userscript 不是 view 作用域命令：不接收 ControlledView，由 main 在
 * runBrowserCommandOnView 顶部拦截（不进 browserGuestManager）。
 * 本模块不持有状态：一切事实以 manifest（SettingService）+ 现场扫描为准。
 */

/** 服务端口：生产实现为 userscriptBootstrap 安装的 UserscriptService，测试可注入假实现。 */
export interface UserscriptCommandPort {
  listStatus(): Promise<UserScriptStatusItem[]>;
  reload(): Promise<UserScriptStatusItem[]>;
  setAgentEnabled(
    scriptId: string,
    enabled: boolean,
  ): Promise<
    | { ok: true; changed: boolean; status: UserScriptStatusItem }
    | { ok: false; error: "unknown_script" }
  >;
}

function done(partial: Omit<BrowserCommandResult, "elapsedMs">): BrowserCommandResult {
  return { ...partial, elapsedMs: 0 };
}

/** 运行时兜底校验（schema 已在协议层拦截；这里防 mock/手拼请求绕过）。 */
function parseUserscriptSetEnabledCommand(
  command: unknown,
): { scriptId: string; enabled: boolean } | null {
  if (typeof command !== "object" || command === null) return null;
  const record = command as { scriptId?: unknown; enabled?: unknown };
  if (typeof record.scriptId !== "string" || record.scriptId.trim().length === 0) return null;
  if (typeof record.enabled !== "boolean") return null;
  return { scriptId: record.scriptId, enabled: record.enabled };
}

/**
 * 识别并执行 userscript 命令；非 userscript 命令返回 null（调用方继续原命令链路）。
 * 服务未安装（app 未 ready / 测试环境）按 backend_unavailable 失败，不静默假装成功。
 */
export async function maybeHandleUserscriptCommand(
  command: unknown,
  port: UserscriptCommandPort | null,
): Promise<BrowserCommandResult | null> {
  if (typeof command !== "object" || command === null) return null;
  const method = (command as { method?: unknown }).method;

  const handle = async (
    execute: () => Promise<Omit<BrowserCommandResult, "elapsedMs">>,
  ): Promise<BrowserCommandResult> => {
    const startedAt = Date.now();
    try {
      return { ...(await execute()), elapsedMs: Date.now() - startedAt };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "execution_error",
          message: error instanceof Error ? error.message : String(error),
        },
        elapsedMs: Date.now() - startedAt,
      };
    }
  };

  if (method === "userscript_list") {
    if (!port) {
      return done(unavailableResult("userscript_list"));
    }
    return handle(async () => {
      const scripts = await port.listStatus();
      return { ok: true, value: { scripts } };
    });
  }
  if (method === "userscript_reload") {
    if (!port) {
      return done(unavailableResult("userscript_reload"));
    }
    return handle(async () => {
      const scripts = await port.reload();
      return { ok: true, value: { scripts } };
    });
  }
  if (method === "userscript_set_enabled") {
    const parsed = parseUserscriptSetEnabledCommand(command);
    if (!parsed) {
      return done({
        ok: false,
        error: {
          code: "execution_error",
          message: "userscript_set_enabled requires non-empty scriptId and boolean enabled",
        },
      });
    }
    if (!port) {
      return done(unavailableResult("userscript_set_enabled"));
    }
    return handle(async () => {
      const result = await port.setAgentEnabled(parsed.scriptId, parsed.enabled);
      if (!result.ok) {
        return {
          ok: false,
          error: {
            code: "ref_not_found",
            message: `userscript '${parsed.scriptId}' not found in the scripts directory`,
          },
        };
      }
      return {
        ok: true,
        value: { scriptId: parsed.scriptId, changed: result.changed, status: result.status },
      };
    });
  }
  return null;
}

function unavailableResult(method: string): Omit<BrowserCommandResult, "elapsedMs"> {
  return {
    ok: false,
    error: {
      code: "backend_unavailable",
      message: `userscript runtime is not installed; command ${method} cannot run`,
    },
  };
}
