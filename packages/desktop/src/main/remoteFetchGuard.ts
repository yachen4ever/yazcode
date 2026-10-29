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
  ["198.18.0.0", 15],
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
 * 不给「多 A 记录里挑一个公网」的绕过面）。
 */
export async function resolvePublicAddresses(
  url: URL,
  lookupImpl: RemoteLookupImpl = lookup,
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
  return addresses;
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
      const addresses = await resolvePublicAddresses(currentUrl, lookupImpl);
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
