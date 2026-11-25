/**
 * settings 写入日志的脱敏序列化（26.5.12 安全修复，issue #46）。
 *
 * 背景：settingService 写盘日志曾整体 `JSON.stringify(settings)`——含
 * `openvikingConnection.userKey`（OV 用户密钥）与内部服务地址，违反仓库纪律
 * 「不在日志、示例或提交中写入凭据、真实用户数据和内部服务地址」。
 *
 * 规则（对对象键名大小写不敏感）：
 * - 凭据类键（userKey/apiKey/token/secret/password/passphrase/credential 等）：
 *   沿本包既有掩码约定（zaiProviderAdapter.maskAccessToken：≤8 位全长星号，
 *   否则前 4 + `...` + 后 4，便于换 key 排查时辨识）；空串原样；
 *   非字符串统一 `[REDACTED]`。
 * - 地址类键（url/baseUrl/endpoint）：保留 scheme + `://***`（如 `http://***`），
 *   可辨识协议但不落 host。
 * - 其余字段原样（保留调试价值：写入日志仍可用于排查非敏感字段问题）。
 * - 深度上限 10 防意外环；数组逐项处理。
 */

const SENSITIVE_KEY_PATTERN = /(userkey|api[_-]?key|token|secret|password|passphrase|credential)/i;
const ADDRESS_KEY_PATTERN = /(url|endpoint)/i;
const REDACTED = "[REDACTED]";
const MAX_DEPTH = 10;

function redactCredentialValue(value: unknown): string {
  if (typeof value !== "string") return REDACTED;
  if (value.length === 0) return value;
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function redactAddressValue(value: unknown): string {
  if (typeof value !== "string") return REDACTED;
  const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value.trim());
  return match ? `${match[1]}://***` : REDACTED;
}

export function redactSettingsForLog<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH) return "[DEPTH-LIMIT]" as T;
  if (Array.isArray(value)) {
    return value.map((entry) => redactSettingsForLog(entry, depth + 1)) as T;
  }
  if (value && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        redacted[key] = redactCredentialValue(entry);
      } else if (ADDRESS_KEY_PATTERN.test(key)) {
        redacted[key] = redactAddressValue(entry);
      } else {
        redacted[key] = redactSettingsForLog(entry, depth + 1);
      }
    }
    return redacted as T;
  }
  return value;
}

/** 日志形态：脱敏后的 JSON 字符串（settingService 写盘日志专用）。 */
export function redactedSettingsJsonForLog(settings: unknown): string {
  return JSON.stringify(redactSettingsForLog(settings));
}
