import { lookup } from "node:dns/promises";
import { BlockList } from "node:net";
import type { LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

/**
 * 远程拉取的 SSRF 守卫（从 desktopSaveFile.ts 提取，desktopSaveFile 与 P4 的
 * userscriptUrlInstall 共用同一套实现，不复制规则）：
 * - BlockList 拒绝私网/环回/链路本地/保留段（IPv4 + IPv6）；
 * - 初始地址与每一跳重定向都先解析公网地址，再把解析结果钉扎到连接阶段
 *   （dispatcher 禁止底层再次解析域名），关闭「预检查公网、实际连接私网」的
 *   DNS rebinding 窗口；
 * - redirect: "manual" 逐跳校验协议白名单，跳数上限内不透传自动重定向；
 * - 整个操作（连接 + 响应头 + body 读取）由单个超时 AbortSignal 约束；
 * - body 边读边计数，超限立即 abort——容量限制必须在读取过程中执行，
 *   完整缓冲后再校验无法保护 renderer/main 内存，也无法拦截无 content-length
 *   的 chunked 响应。
 *
 * 错误以 RemoteFetchError 显式码上抛，调用方各自映射为自己的契约错误
 * （desktopSaveFile → SaveFileError 语义，userscriptUrlInstall → IabUserscript 错误码）。
 */

export type RemoteFetchErrorCode =
  | "invalid_url"
  | "protocol_not_allowed"
  | "remote_address_not_allowed"
  | "download_failed"
  | "too_large"
  | "timeout";

export class RemoteFetchError extends Error {
  constructor(readonly code: RemoteFetchErrorCode) {
    super(`remote fetch guard: ${code}`);
  }
}

/** 私网/环回/链路本地/保留段黑名单（IPv4 + IPv6），模块级构建一次。 */
export const blockedRemoteAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedRemoteAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const) {
  blockedRemoteAddresses.addSubnet(network, prefix, "ipv6");
}

/**
 * 198.18.0.0/15（RFC 2544 基准保留段）单独拆出（R1 b394a80f 引入，R2 重设计其语义，
 * spec 见 docs/specs/iab-userscripts.md 实现边界 4b）。
 *
 * fake-ip 模式把所有域名的系统 DNS 解析结果映射到该段：R1 的「命中即放行」救活了
 * 真公网域名，但也把「域名伪装的内网/回环目标」（127-0-0-1.sslip.io 等）放行至
 * 下载层——fake-ip 下本地解析对公网/内网零区分度。R2 语义：命中该段触发 DoH
 * 独立解析复核，按真实 IP 执行黑名单判定；复核失败 fail-closed。
 */
export const proxyTunnelFakeIpAddresses = new BlockList();
proxyTunnelFakeIpAddresses.addSubnet("198.18.0.0", 15, "ipv4");

/** DoH JSON API 端点（RFC 8484 之外的 Cloudflare/Google 兼容 JSON 形态，443/TLS）。 */
export const DEFAULT_DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const DOH_TIMEOUT_MS = 3_000;
const DNS_TYPE_A = 1;
const DNS_TYPE_AAAA = 28;

interface DohJsonResponse {
  Status?: number;
  Answer?: Array<{ type?: number; data?: string }>;
}

/** DoH JSON 查询的注入面：给定完整请求 URL，返回解析后的 JSON 体。 */
export type RemoteDohJsonImpl = (url: string) => Promise<unknown>;

export type RemoteLookupAddress = Awaited<ReturnType<typeof lookup>>;

export type RemoteFetchImpl = typeof undiciFetch;
export type RemoteLookupImpl = typeof lookup;

export interface RemoteFetchGuardOptions {
  /** 允许的 URL scheme（含冒号），如 ["https:"]；初始地址与每一跳重定向都校验。 */
  allowedProtocols: readonly string[];
  maxRedirects: number;
  maxBytes: number;
  timeoutMs: number;
  /** 测试注入；缺省 undici fetch。 */
  fetchImpl?: RemoteFetchImpl;
  /** 测试注入；缺省 dns.promises.lookup。 */
  lookupImpl?: RemoteLookupImpl;
  /** 测试注入；缺省 DoH JSON API（DEFAULT_DOH_ENDPOINT）。 */
  dohJsonImpl?: RemoteDohJsonImpl;
}

export interface RemoteFetchGuardResult {
  /** 重定向后的最终地址（用户核对来源以它为准）。 */
  finalUrl: URL;
  /** 实际接收的字节数（无论是否经 onChunk 转发）。 */
  totalBytes: number;
  /**
   * 未传 onChunk 时为完整字节（内存缓冲）；传了 onChunk 则为 null
   * （流式转发给调用方，如 desktopSaveFile 边读边写临时文件，内存有界）。
   */
  bytes: Uint8Array | null;
}

/**
 * 解析公网地址：localhost（含子域）直接拒绝；DNS 查询异常归 download_failed；
 * 任一解析结果落在黑名单内即拒绝（some 语义：存在私网解析就整体拒绝，
 * 不给「多 A 记录里挑一个公网」的绕过面）。解析结果落入 fake-ip 段
 * （proxyTunnelFakeIpAddresses）时触发 DoH 独立解析复核——fake-ip 环境下本地
 * 解析对公网/内网零区分度，按 DoH 真实 IP 执行同一黑名单判定，复核失败
 * fail-closed（R2 重设计，spec 见 docs/specs/iab-userscripts.md 实现边界 4b）。
 */
export async function resolvePublicAddresses(
  url: URL,
  lookupImpl: RemoteLookupImpl = lookup,
  dohJsonImpl: RemoteDohJsonImpl = defaultDohJson,
): Promise<RemoteLookupAddress> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new RemoteFetchError("remote_address_not_allowed");
  }
  let addresses: RemoteLookupAddress;
  try {
    addresses = await lookupImpl(hostname, { all: true, verbatim: true });
  } catch {
    throw new RemoteFetchError("download_failed");
  }
  if (
    addresses.length === 0 ||
    addresses.some(({ address, family }) =>
      blockedRemoteAddresses.check(address, family === 6 ? "ipv6" : "ipv4"),
    )
  ) {
    throw new RemoteFetchError("remote_address_not_allowed");
  }
  const hitsFakeIp = addresses.some(({ address, family }) =>
    proxyTunnelFakeIpAddresses.check(address, family === 6 ? "ipv6" : "ipv4"),
  );
  if (hitsFakeIp) {
    // fake-ip 环境：本地解析无区分度，用独立 DNS 通道拿真实解析结果再判。
    const verified = await resolveDohAddresses(hostname, dohJsonImpl);
    if (
      !verified ||
      verified.length === 0 ||
      verified.some(({ address, family }) =>
        blockedRemoteAddresses.check(address, family === 6 ? "ipv6" : "ipv4"),
      )
    ) {
      throw new RemoteFetchError("remote_address_not_allowed");
    }
  }
  return addresses;
}

/** 缺省 DoH JSON 查询：A/AAAA 并发，3s 超时；任何失败由调用方按 fail-closed 处理。 */
async function defaultDohJson(url: string): Promise<unknown> {
  const response = await undiciFetch(url, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`DoH ${response.status}`);
  }
  return response.json();
}

/**
 * DoH 独立解析：并发查 A + AAAA，只保留 A/AAAA Answer 的 data（CNAME 等中间记录
 * 忽略）。Status 非 0（NXDOMAIN 等）、无 Answer、网络失败一律返回 null——调用方
 * 按「无法证明是公网」拒绝，不做 fail-open。
 */
async function resolveDohAddresses(
  hostname: string,
  dohJsonImpl: RemoteDohJsonImpl,
): Promise<RemoteLookupAddress[] | null> {
  const query = (type: number) =>
    dohJsonImpl(`${DEFAULT_DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${type}`);
  let answers: Array<{ type?: number; data?: string }>;
  try {
    const [a, aaaa] = await Promise.all([query(DNS_TYPE_A), query(DNS_TYPE_AAAA)]);
    for (const response of [a, aaaa]) {
      const status = (response as DohJsonResponse)?.Status;
      if (typeof status === "number" && status !== 0) return null;
    }
    answers = [
      ...((a as DohJsonResponse)?.Answer ?? []),
      ...((aaaa as DohJsonResponse)?.Answer ?? []),
    ];
  } catch {
    return null;
  }
  const resolved: RemoteLookupAddress[] = [];
  for (const { type, data } of answers) {
    if (!data || (type !== DNS_TYPE_A && type !== DNS_TYPE_AAAA)) continue;
    const family = type === DNS_TYPE_A ? 4 : 6;
    // Answer.data 必须是可被 BlockList 校验的地址形态；畸形记录按无此记录处理。
    if (family === 4 && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(data)) continue;
    if (family === 6 && !data.includes(":")) continue;
    resolved.push({ address: data, family });
  }
  return resolved;
}

function assertAllowedProtocol(url: URL, allowedProtocols: readonly string[]): void {
  if (!allowedProtocols.includes(url.protocol)) {
    throw new RemoteFetchError("protocol_not_allowed");
  }
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

type GuardedResponse = Awaited<ReturnType<typeof undiciFetch>>;

/**
 * 带守卫的远程拉取：返回最终地址与 body 字节。
 * onChunk 提供时逐块转发（调用方负责落盘/累计，内存有界），不传时内存缓冲后一次性返回。
 */
export async function fetchRemoteWithGuard(
  initialUrl: URL,
  options: RemoteFetchGuardOptions,
  onChunk?: (chunk: Uint8Array) => void | Promise<void>,
): Promise<RemoteFetchGuardResult> {
  const {
    allowedProtocols,
    maxRedirects,
    maxBytes,
    timeoutMs,
    fetchImpl = undiciFetch,
    lookupImpl = lookup,
    dohJsonImpl = defaultDohJson,
  } = options;

  assertAllowedProtocol(initialUrl, allowedProtocols);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let activeDispatcher: Agent | null = null;
  let currentUrl = initialUrl;
  const chunks: Uint8Array[] = [];

  try {
    let response: GuardedResponse | null = null;
    // 与 desktopSaveFile 原实现同构：初始 + maxRedirects 跳重定向，共 maxRedirects+1 次请求。
    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      assertAllowedProtocol(currentUrl, allowedProtocols);
      const addresses = await resolvePublicAddresses(currentUrl, lookupImpl, dohJsonImpl);
      const pinnedLookup: LookupFunction = (_hostname, lookupOptions, callback) => {
        if (lookupOptions.all) {
          callback(null, addresses);
          return;
        }
        const address = addresses[0];
        if (!address) {
          callback(new Error("download_failed"), "");
          return;
        }
        callback(null, address.address, address.family);
      };
      // DNS 校验结果必须绑定到连接阶段；dispatcher 禁止底层再次解析域名，
      // 从而关闭“预检查公网、实际连接私网”的 DNS rebinding 窗口。
      const dispatcher = new Agent({ connect: { lookup: pinnedLookup } });
      try {
        response = await fetchImpl(currentUrl, {
          dispatcher,
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (error) {
        await dispatcher.close();
        throw error;
      }
      if (!isRedirectStatus(response.status)) {
        // 响应体尚在读取；dispatcher 留到 finally（body 读完）再关，避免切断连接。
        activeDispatcher = dispatcher;
        break;
      }

      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get("location");
      await dispatcher.close();
      response = null;
      if (!location || redirectCount === maxRedirects) {
        throw new RemoteFetchError("download_failed");
      }
      let redirectedUrl: URL;
      try {
        redirectedUrl = new URL(location, currentUrl);
      } catch {
        throw new RemoteFetchError("download_failed");
      }
      currentUrl = redirectedUrl;
    }

    if (!response || !response.ok || !response.body) {
      throw new RemoteFetchError("download_failed");
    }
    // content-length 预检先拒绝已知超限；无 content-length（chunked）由下面的
    // 边读边计数兜底（P4 验收场景 8 显式要求覆盖该分支）。
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new RemoteFetchError("too_large");
    }

    reader = response.body.getReader();
    let receivedBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        controller.abort();
        throw new RemoteFetchError("too_large");
      }
      if (onChunk) {
        await onChunk(value);
      } else {
        chunks.push(value);
      }
    }
    return {
      finalUrl: currentUrl,
      totalBytes: receivedBytes,
      bytes: onChunk ? null : concatChunks(chunks, receivedBytes),
    };
  } catch (error) {
    if (error instanceof RemoteFetchError) throw error;
    // 超时由 AbortSignal 触发：guard 内统一映射为 timeout，调用方无需识别 AbortError。
    if (controller.signal.aborted) throw new RemoteFetchError("timeout");
    throw error;
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await reader?.cancel().catch(() => undefined);
    await activeDispatcher?.close().catch(() => undefined);
  }
}

function concatChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}
