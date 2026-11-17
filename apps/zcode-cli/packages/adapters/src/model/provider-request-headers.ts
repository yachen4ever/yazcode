/**
 * Provider 自定义请求头（api.headers）在并入请求前的解析（26.5.10，issue #36，
 * spec docs/specs/provider-custom-headers.md）。
 *
 * - `{{sessionId}}` 占位符 → 当前会话 ID（口径同请求归因头：
 *   normalizeModelSessionIdForAttribution，strip sess_/subagent_agent_ 前缀；
 *   每会话稳定，非每请求随机——prompt 缓存命中的前提）。
 * - 未知占位符与会话 ID 缺失时的 `{{sessionId}}` 均原样保留（不吞头、不产生空值）。
 * - 保护头（鉴权/传输栈关键头）丢弃并返回清单，由调用方经既有 Logger 告警；
 *   与 new-api 插件保护头名单对齐。
 * - 静态值（无占位符）行为不变。
 */

import type { ModelStatusContext } from "./runner-status.js";
import { normalizeModelSessionIdForAttribution } from "./runner-attribution.js";

export const PROVIDER_SESSION_ID_PLACEHOLDER = "{{sessionId}}";

/** 大小写不敏感比较；这些头由网络栈/鉴权链管理，provider 配置不得覆盖。 */
export const PROTECTED_PROVIDER_HEADER_NAMES: ReadonlySet<string> = new Set([
  "authorization",
  "host",
  "content-length",
  "content-type",
  "content-encoding",
  "cookie",
]);

export interface ResolvedProviderRequestHeaders {
  /** 替换占位符、剔除保护头后的最终头集合。 */
  headers: Record<string, string>;
  /** 被丢弃的保护头原始名（用于调用方告警；空数组表示无丢弃）。 */
  droppedProtectedHeaders: string[];
}

export function resolveProviderRequestHeaders(
  providerHeaders: Record<string, string> | undefined,
  statusContext: Pick<ModelStatusContext, "sessionId">,
): ResolvedProviderRequestHeaders {
  if (!providerHeaders) return { headers: {}, droppedProtectedHeaders: [] };
  const sessionId = normalizeModelSessionIdForAttribution(statusContext.sessionId);
  const headers: Record<string, string> = {};
  const droppedProtectedHeaders: string[] = [];
  for (const [name, rawValue] of Object.entries(providerHeaders)) {
    if (PROTECTED_PROVIDER_HEADER_NAMES.has(name.trim().toLowerCase())) {
      droppedProtectedHeaders.push(name);
      continue;
    }
    headers[name] = sessionId
      ? rawValue.replaceAll(PROVIDER_SESSION_ID_PLACEHOLDER, sessionId)
      : rawValue;
  }
  return { headers, droppedProtectedHeaders };
}
