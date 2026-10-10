import { X509Certificate, createHash } from "node:crypto";
import type { PeerCertificate } from "node:tls";
import { checkServerIdentity as tlsCheckServerIdentity } from "node:tls";
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


/** 证书钉扎 fetch：校验保持开启，信任锚 = 导入的自签证书（含 CA 链）。 */
export function createPinnedCertFetch<F extends (input: any, init?: any) => Promise<Response>>(
  baseFetch: F,
  baseUrl: string,
  caPem: string,
): F {
  let origin: string;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:") return baseFetch;
    origin = url.origin;
  } catch {
    return baseFetch;
  }
  const pemKey = createHash("sha256").update(caPem).digest("hex");
  let agent = pinnedAgents.get(pemKey);
  if (!agent) {
    // 网关地址常为 IP 且自签证书未必带 IP SAN——标准主机名校验会拒绝。
    // 回退到指纹比对：对方必须出示与导入证书完全一致的证书（私钥在手才可能），
    // 中间人伪造不出，安全性等同钉扎。
    let pinnedFingerprint: string | null = null;
    try {
      pinnedFingerprint = new X509Certificate(caPem).fingerprint256;
    } catch {
      // PEM 解析失败时保持标准校验（ca 仍会传入 Node）
    }
    agent = new Agent({
      connect: {
        ca: caPem,
        rejectUnauthorized: true,
        ...(pinnedFingerprint
          ? {
              checkServerIdentity: (host: string, cert: { raw: Uint8Array } & PeerCertificate) => {
                const standardError = tlsCheckServerIdentity(host, cert as PeerCertificate);
                if (!standardError) return undefined;
                try {
                  const peer = new X509Certificate(cert.raw);
                  if (peer.fingerprint256 === pinnedFingerprint) return undefined;
                  return new Error(
                    `证书指纹不匹配：期望 ${pinnedFingerprint.slice(0, 16)}…，实际 ${peer.fingerprint256.slice(0, 16)}…`,
                  );
                } catch {
                  return standardError;
                }
              },
            }
          : {}),
      },
    });
    pinnedAgents.set(pemKey, agent);
  }
  const wrapped = ((input: any, init: any) =>
    baseFetch(input, { ...(init ?? {}), dispatcher: agent })) as F;
  return wrapped;
}

const pinnedAgents = new Map<string, Agent>();
