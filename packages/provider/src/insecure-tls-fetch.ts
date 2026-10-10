import { Agent } from "undici";

/**
 * 自签名证书服务商的 TLS 放行 fetch。
 *
 * Node 的全局 fetch 用内置 Mozilla CA 包做校验，不读 Windows 证书库——内网
 * 自签 HTTPS 网关在公司机器装了信任也救不了 Node 侧。这里按 origin 缓存
 * undici Agent（rejectUnauthorized: false），只对显式启用的 Provider 生效，
 * 不做任何全局放行。
 *
 * 依赖 Node 全局 fetch（即 undici）对 RequestInit 的 `dispatcher` 扩展：
 * 该扩展虽未写进标准，但在 Node 18+ 的全局 fetch 上稳定可用。
 * 参数刻意用 any：本包装是运行时的 duck-typing 层，泛型保持调用方窄签名
 * 在 TS 下反而不可满足（init 的协变方向与 spread 冲突）。
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- 见文件头说明 */

const agents = new Map<string, Agent>();

export function createInsecureTlsFetch<F extends (input: any, init?: any) => Promise<Response>>(
  baseFetch: F,
  baseUrl: string,
): F {
  let origin: string;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:") return baseFetch;
    origin = url.origin;
  } catch {
    return baseFetch;
  }
  let agent = agents.get(origin);
  if (!agent) {
    agent = new Agent({ connect: { rejectUnauthorized: false } });
    agents.set(origin, agent);
  }
  const wrapped = ((input: any, init: any) =>
    baseFetch(input, { ...(init ?? {}), dispatcher: agent })) as F;
  return wrapped;
}
