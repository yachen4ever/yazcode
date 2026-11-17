import { Output, jsonSchema } from "ai";
import type { Logger, ModelToolChoice } from "@zcode/contracts";
import type { EnvRecord } from "./model-execution.js";
import { toAiSdkMessages } from "./transform.js";
import { toAiSdkTools } from "./tool-transform.js";
import type {
  AiSdkGenerateTextOptions,
  AiSdkModelTextRequest,
  AiSdkStreamTextOptions,
  ResolvedAiSdkModel,
} from "./runner-runtime.js";
import { createModelRequestAttributionHeaders, type ModelStatusContext } from "./runner-status.js";
import { resolveProviderRequestHeaders } from "./provider-request-headers.js";
import { findMisplacedSystemPositions } from "./system-message-compat.js";

type ExperimentalIncludeWithResponseBody = {
  requestBody?: boolean;
  responseBody?: boolean;
};

/** zcode-plan 业务码常只出现在 finish chunk 的 response.body，流式路径需显式开启。 */
function shouldIncludeStreamResponseBody(resolved: ResolvedAiSdkModel): boolean {
  return (
    resolved.providerKind === "openai-compatible" && resolved.accountAccess?.mode === "start-plan"
  );
}

/** 保护头丢弃告警进程级去重：同一 header 名只 warn 一次，防每请求刷屏。 */
const warnedProtectedProviderHeaders = new Set<string>();

function warnDroppedProtectedProviderHeadersOnce(
  logger: Logger | undefined,
  droppedProtectedHeaders: readonly string[],
): void {
  for (const name of droppedProtectedHeaders) {
    const key = name.trim().toLowerCase();
    if (warnedProtectedProviderHeaders.has(key)) continue;
    warnedProtectedProviderHeaders.add(key);
    logger?.warn("Provider api.headers 中的保护头已丢弃（不得由配置覆盖鉴权/传输栈）", {
      header: name,
    });
  }
}

/**
 * Provider 自定义头（api.headers）先按占位符/保护头解析，再并入请求归因头
 * （26.5.10，issue #36，spec provider-custom-headers.md）：归因头覆盖 provider
 * 同名配置——内部归因不可被配置覆盖；provider 头只填补归因集合之外的键。
 */
function mergeRequestHeaders(
  providerHeaders: Record<string, string> | undefined,
  attributionHeaders: Record<string, string>,
  statusContext: ModelStatusContext,
  logger?: Logger,
): Record<string, string> {
  const resolved = resolveProviderRequestHeaders(providerHeaders, statusContext);
  warnDroppedProtectedProviderHeadersOnce(logger, resolved.droppedProtectedHeaders);
  return {
    ...resolved.headers,
    ...attributionHeaders,
  };
}

export function createGenerateTextOptions(input: {
  anthropicMetadataUserId?: string;
  env?: EnvRecord;
  includeModelIO: boolean;
  request: AiSdkModelTextRequest;
  resolved: ResolvedAiSdkModel;
  statusContext: ModelStatusContext;
  /** 保护头丢弃告警通道（可选；缺省静默丢弃，安全性不变）。 */
  logger?: Logger;
}): AiSdkGenerateTextOptions {
  const providerOptions = mergeProviderOptions(
    input.resolved.providerOptions,
    input.request.providerOptions,
  );
  const providerOptionsWithMetadata = mergeAnthropicRequestMetadata({
    metadataUserId: input.anthropicMetadataUserId,
    providerKind: input.resolved.providerKind ?? "(missing)",
    providerOptions,
  });
  const requestProviderOptions = withNativeGenerateOutputFormat({
    providerOptions: providerOptionsWithMetadata,
    responseJsonSchema: input.request.responseJsonSchema,
    resolved: input.resolved,
  });
  const generateMessages = toAiSdkMessages(input.request.messages, {
    apiFormat: resolveProviderApiFormat(providerOptions),
    providerOptions,
    providerKind: input.resolved.providerKind ?? "(missing)",
    inputFormat: input.resolved.properties?.inputFormat,
  });
  const generateMisplaced = findMisplacedSystemPositions(generateMessages);
  if (generateMisplaced.length > 0) {
    // 诊断用 metadata 透传给 runner（logger 在 runner 层），不在这里落日志。
    (generateMessages as { __misplacedSystemPositions?: number[] }).__misplacedSystemPositions =
      generateMisplaced;
  }
  return removeUndefined({
    model: input.resolved.model,
    messages: generateMessages,
    tools: toAiSdkTools(input.request.tools, {
      providerKind: input.resolved.providerKind ?? "(missing)",
      modelId: input.resolved.modelId,
      requiresMfjsToolSchema: input.resolved.properties.requiresMfjsToolSchema,
      supportsNativeWebSearch: input.resolved.properties.supportsNativeWebSearch,
    }),
    toolChoice: toAiSdkToolChoice(input.request.toolChoice),
    temperature: input.request.temperature,
    topP: input.request.topP,
    topK: input.request.topK,
    presencePenalty: input.request.presencePenalty,
    frequencyPenalty: input.request.frequencyPenalty,
    stopSequences: input.request.stopSequences,
    seed: input.request.seed,
    output: input.request.responseJsonSchema
      ? Output.object({ schema: jsonSchema(input.request.responseJsonSchema) })
      : undefined,
    providerOptions: requestProviderOptions,
    abortSignal: input.request.abortSignal,
    headers: mergeRequestHeaders(
      input.resolved.headers,
      createModelRequestAttributionHeaders(input.statusContext),
      input.statusContext,
      input.logger,
    ),
    // ZCode owns system-message construction in core/context. Keep AI SDK from
    // printing its generic system-message warning to process stderr.
    allowSystemInMessages: true,
    maxRetries: 0,
    experimental_include: input.includeModelIO
      ? {
          requestBody: true,
          responseBody: true,
        }
      : undefined,
  }) as AiSdkGenerateTextOptions;
}

export function createStreamTextOptions(input: {
  anthropicMetadataUserId?: string;
  env?: EnvRecord;
  includeModelIO: boolean;
  request: AiSdkModelTextRequest;
  resolved: ResolvedAiSdkModel;
  statusContext: ModelStatusContext;
  /** 保护头丢弃告警通道（可选；缺省静默丢弃，安全性不变）。 */
  logger?: Logger;
}): AiSdkStreamTextOptions {
  const providerOptions = mergeProviderOptions(
    input.resolved.providerOptions,
    input.request.providerOptions,
  );
  const requestProviderOptions = mergeAnthropicRequestMetadata({
    metadataUserId: input.anthropicMetadataUserId,
    providerKind: input.resolved.providerKind ?? "(missing)",
    providerOptions,
  });
  const streamMessages = toAiSdkMessages(input.request.messages, {
    apiFormat: resolveProviderApiFormat(providerOptions),
    providerOptions,
    providerKind: input.resolved.providerKind ?? "(missing)",
    inputFormat: input.resolved.properties?.inputFormat,
  });
  const streamMisplaced = findMisplacedSystemPositions(streamMessages);
  if (streamMisplaced.length > 0) {
    (streamMessages as { __misplacedSystemPositions?: number[] }).__misplacedSystemPositions =
      streamMisplaced;
  }
  return removeUndefined({
    model: input.resolved.model,
    messages: streamMessages,
    tools: toAiSdkTools(input.request.tools, {
      providerKind: input.resolved.providerKind ?? "(missing)",
      modelId: input.resolved.modelId,
      requiresMfjsToolSchema: input.resolved.properties.requiresMfjsToolSchema,
      supportsNativeWebSearch: input.resolved.properties.supportsNativeWebSearch,
    }),
    toolChoice: toAiSdkToolChoice(input.request.toolChoice),
    temperature: input.request.temperature,
    topP: input.request.topP,
    topK: input.request.topK,
    presencePenalty: input.request.presencePenalty,
    frequencyPenalty: input.request.frequencyPenalty,
    stopSequences: input.request.stopSequences,
    seed: input.request.seed,
    providerOptions: requestProviderOptions,
    abortSignal: input.request.abortSignal,
    headers: mergeRequestHeaders(
      input.resolved.headers,
      createModelRequestAttributionHeaders(input.statusContext),
      input.statusContext,
      input.logger,
    ),
    // ZCode owns system-message construction in core/context. Keep AI SDK from
    // printing its generic system-message warning to process stderr.
    allowSystemInMessages: true,
    maxRetries: 0,
    // AI SDK 会吞掉 Anthropic message_start 等 metadata 事件；compact 需要
    // 在 adapter 内观察 raw event 才能精确结束 SSE retry，raw chunk 不会上送 Core/UI。
    includeRawChunks: input.request.preserveProviderStreamBoundaries ? true : undefined,
    // zcode-plan 的业务码可能只在流式响应尾部 body 里，需保留 responseBody 供错误分类读取。
    experimental_include: createStreamExperimentalInclude(input),
  }) as AiSdkStreamTextOptions;
}

function createStreamExperimentalInclude(input: {
  includeModelIO: boolean;
  resolved: ResolvedAiSdkModel;
}): ExperimentalIncludeWithResponseBody | undefined {
  if (input.includeModelIO) {
    return {
      requestBody: true,
      responseBody: true,
    };
  }
  return shouldIncludeStreamResponseBody(input.resolved) ? { responseBody: true } : undefined;
}

function toAiSdkToolChoice(
  toolChoice?: ModelToolChoice,
): AiSdkGenerateTextOptions["toolChoice"] | undefined {
  return toolChoice as AiSdkGenerateTextOptions["toolChoice"] | undefined;
}

function mergeProviderOptions(
  base?: Record<string, unknown>,
  override?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!base && !override) {
    return undefined;
  }
  return {
    ...base,
    ...override,
  };
}

function withNativeGenerateOutputFormat(input: {
  providerOptions: Record<string, unknown> | undefined;
  resolved: ResolvedAiSdkModel;
  responseJsonSchema: AiSdkModelTextRequest["responseJsonSchema"];
}): Record<string, unknown> | undefined {
  if (!input.responseJsonSchema || input.resolved.providerKind !== "anthropic") {
    return input.providerOptions;
  }

  const anthropicOptions = asPlainRecord(input.providerOptions?.anthropic);
  return {
    ...input.providerOptions,
    // Lite role 的真实模型 ID 可能不在 AI SDK 的静态能力表中；
    // 显式 schema 必须继续生成目标 output_config，而不能退化成 JSON tool。
    anthropic: { ...anthropicOptions, structuredOutputMode: "outputFormat" },
  };
}

function mergeAnthropicRequestMetadata(input: {
  metadataUserId: string | undefined;
  providerKind: ResolvedAiSdkModel["providerKind"];
  providerOptions: Record<string, unknown> | undefined;
}): Record<string, unknown> | undefined {
  if (input.providerKind !== "anthropic" || input.metadataUserId === undefined) {
    return input.providerOptions;
  }

  const anthropicOptions = asPlainRecord(input.providerOptions?.anthropic) ?? {};
  const metadata = asPlainRecord(anthropicOptions.metadata) ?? {};
  return {
    ...input.providerOptions,
    anthropic: {
      ...anthropicOptions,
      metadata: {
        ...metadata,
        userId: input.metadataUserId,
      },
    },
  };
}

function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function resolveProviderApiFormat(providerOptions?: Record<string, unknown>): string | undefined {
  const apiFormat = providerOptions?.apiFormat;
  return typeof apiFormat === "string" ? apiFormat : undefined;
}

function removeUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as Partial<T>;
}
