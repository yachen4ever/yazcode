// ============================================================
// Vision bridge request execution（视觉桥接的 openai 兼容请求面）
// ============================================================

import {
  createInsecureTlsFetch,
  createPinnedCertFetch,
} from "@zcode/provider/insecure-tls-fetch";
import { createNetworkProxyFetch } from "../network/proxy-fetch.js";

/**
 * 桥接请求只做一件事：把一张图的 data URL 交给 fallback 视觉模型换回文字描述。
 * 请求面刻意收窄为 openai 兼容 chat/completions 单轮对话——桥接目标由用户在
 * 设置页从真实模型清单中挑选，不做能力探测，也无需流式与工具。
 */

export const VISION_BRIDGE_PROMPT =
  "Describe this image in detail, including any visible text.";
export const VISION_BRIDGE_MAX_OUTPUT_TOKENS = 1024;
export const VISION_BRIDGE_TIMEOUT_MS = 60_000;

type BridgeFetch = typeof globalThis.fetch;

/**
 * chat/completions 请求 URL：base 以 /v1 结尾则原样拼接，否则补 /v1。
 * 与 model-provider-remote-model-detection 的 URL 语义保持一致；
 * 尾部斜杠先归一化，避免产生 //chat/completions。
 */
export function resolveVisionBridgeChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/u, "");
  return trimmed.toLowerCase().endsWith("/v1")
    ? `${trimmed}/chat/completions`
    : `${trimmed}/v1/chat/completions`;
}

export function buildVisionBridgeChatCompletionsBody(input: {
  modelId: string;
  imageDataUrl: string;
  maxOutputTokens?: number;
  prompt?: string;
}): Record<string, unknown> {
  return {
    max_tokens: input.maxOutputTokens ?? VISION_BRIDGE_MAX_OUTPUT_TOKENS,
    messages: [
      {
        content: [
          { text: input.prompt ?? VISION_BRIDGE_PROMPT, type: "text" },
          { image_url: { url: input.imageDataUrl }, type: "image_url" },
        ],
        role: "user",
      },
    ],
    model: input.modelId,
  };
}

/** 从 chat/completions 响应提取文字描述；content 为分段数组时拼接 text 段。 */
export function parseVisionBridgeChatCompletionsDescription(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const choices = (body as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const message = (choices[0] as Record<string, unknown> | undefined)?.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((part) =>
      part && typeof part === "object" && !Array.isArray(part)
        ? (part as Record<string, unknown>).text
        : undefined,
    )
    .filter((value): value is string => typeof value === "string")
    .join("")
    .trim();
  return text.length > 0 ? text : undefined;
}

export interface VisionBridgeFetchOptions {
  /** fallback provider 的 base URL；TLS 包装按其 origin 生效。 */
  baseUrl: string;
  /** 证书钉扎：与正式执行链同源，优先于跳过校验。 */
  tlsCaPath?: string;
  /** 自签网关无证书导入时的兜底；与 tlsCaPath 互斥。 */
  allowInsecureTls?: boolean;
  env?: Record<string, string | undefined>;
  fetch?: BridgeFetch;
  httpProxy?: string;
  noProxy?: string;
}

/**
 * 桥接出口 fetch：出口代理与模型请求同源（proxy-aware），TLS 语义复用
 * provider 包的钉扎/跳过机制，本模块不另写 TLS 逻辑。
 */
export function createVisionBridgeFetch(options: VisionBridgeFetchOptions): BridgeFetch {
  const baseFetch =
    options.fetch ??
    createNetworkProxyFetch({
      env: options.env,
      fetch: options.fetch,
      httpProxy: options.httpProxy,
      noProxy: options.noProxy,
    });
  if (options.tlsCaPath) {
    return createPinnedCertFetch(baseFetch, options.baseUrl, options.tlsCaPath);
  }
  if (options.allowInsecureTls === true) {
    return createInsecureTlsFetch(baseFetch, options.baseUrl);
  }
  return baseFetch;
}

export interface VisionBridgeDescriptionRequest {
  apiKey?: string;
  baseUrl: string;
  /** 可注入 fetch（测试用）；缺省按出口代理 + TLS 语义装配。 */
  fetch?: BridgeFetch;
  imageDataUrl: string;
  maxOutputTokens?: number;
  modelId: string;
  timeoutMs?: number;
  tlsCaPath?: string;
  allowInsecureTls?: boolean;
  env?: Record<string, string | undefined>;
  httpProxy?: string;
  noProxy?: string;
}

const MAX_BRIDGE_ERROR_BODY_CHARS = 2_000;

/**
 * 单图桥接：返回文字描述；失败抛错（原因进 message，由编排层转占位文本）。
 * 超时经 AbortSignal 兜底，不依赖网关及时响应。
 */
export async function requestVisionBridgeDescription(
  input: VisionBridgeDescriptionRequest,
): Promise<string> {
  const url = resolveVisionBridgeChatCompletionsUrl(input.baseUrl);
  const fetchImpl = createVisionBridgeFetch(input);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("vision bridge request timed out")),
    input.timeoutMs ?? VISION_BRIDGE_TIMEOUT_MS,
  );
  let response: Response;
  try {
    response = await fetchImpl(url, {
      body: JSON.stringify(
        buildVisionBridgeChatCompletionsBody({
          imageDataUrl: input.imageDataUrl,
          maxOutputTokens: input.maxOutputTokens,
          modelId: input.modelId,
        }),
      ),
      headers: {
        "content-type": "application/json",
        ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {}),
      },
      method: "POST",
      signal: controller.signal,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`vision bridge request failed: ${reason}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const summary = await readLimitedErrorBody(response);
    throw new Error(`vision bridge request failed with HTTP ${response.status}${summary}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`vision bridge response is not valid JSON: ${reason}`);
  }
  const description = parseVisionBridgeChatCompletionsDescription(body);
  if (description === undefined) {
    throw new Error("vision bridge response did not contain a text description");
  }
  return description;
}

async function readLimitedErrorBody(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    if (text.length === 0) return "";
    const clipped = text.slice(0, MAX_BRIDGE_ERROR_BODY_CHARS);
    return `: ${clipped}`;
  } catch {
    return "";
  }
}
