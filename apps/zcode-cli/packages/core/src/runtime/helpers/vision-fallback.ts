import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger, ModelInputMessage, ModelMessageContentBlock } from "../deps.js";
import type { VisionBridgeImageRequest, VisionBridgePort } from "../deps.js";

/**
 * 视觉桥接（Vision Fallback）核心判定与编排纯函数。
 *
 * 失败驱动：网关没有模态元数据，无法预判模型是否接受图片；只有请求失败且
 * 错误文本命中多模态拒绝特征时才确认「该模型无视觉」。识别结果记入
 * 进程级 + 落盘的「无视觉」缓存，后续直接桥接不再试错。
 */

/** 多模态拒绝特征；大小写不敏感，HTTP 400/422/503 均可携带。 */
const MULTIMODAL_REJECTION_PATTERNS: RegExp[] = [
  /not a multimodal model/iu,
  /does not support image/iu,
  /image.*not support/iu,
  /unsupported.*image/iu,
  /multimodal/iu,
];

/** 纯函数：文本命中任一特征即视为多模态拒绝；非字符串输入一律不命中。 */
export function matchesMultimodalRejectionText(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  return MULTIMODAL_REJECTION_PATTERNS.some((pattern) => pattern.test(value));
}

const MAX_ERROR_WALK_DEPTH = 6;

/**
 * 判定一次模型请求失败是否为多模态拒绝。
 * 匹配范围：错误的 message 与 string 字段（responseBody 等），沿 cause/error 链下探。
 */
export function isMultimodalRejectionError(error: unknown): boolean {
  let current: unknown = error;
  const seen = new WeakSet<object>();

  for (let depth = 0; depth <= MAX_ERROR_WALK_DEPTH; depth += 1) {
    if (current === undefined || current === null) return false;
    if (typeof current === "string") return matchesMultimodalRejectionText(current);
    if (typeof current !== "object") return false;
    if (seen.has(current)) return false;
    seen.add(current);

    const record = current as Record<string, unknown>;
    if (
      matchesMultimodalRejectionText(record.message) ||
      matchesMultimodalRejectionText(record.responseBody) ||
      matchesMultimodalRejectionText(record.text) ||
      matchesMultimodalRejectionText(record.reason)
    ) {
      return true;
    }
    current = record.cause ?? record.lastError ?? record.error;
  }
  return false;
}

// -----------------------------------------------
// 无视觉缓存（进程 Map + 落盘 json，容错读取）
// -----------------------------------------------

interface NoVisionCacheFile {
  models?: string[];
}

export interface NoVisionModelCache {
  has(providerId: string, modelId: string): boolean;
  add(providerId: string, modelId: string): void;
}

const noVisionCacheByFilePath = new Map<string, Promise<NoVisionModelCache>>();

function noVisionCacheKey(providerId: string, modelId: string): string {
  return `${providerId}\u0000${modelId}`;
}

/**
 * 取（或建）指定缓存文件的进程级缓存实例。同一进程内同一路径共享，
 * 让同进程的多个 session runtime 看到同一份「无视觉」事实。
 * 文件损坏/不可读时回退空缓存继续用（进程内照常累计），不抛错。
 */
export function loadNoVisionModelCache(filePath: string): Promise<NoVisionModelCache> {
  const existing = noVisionCacheByFilePath.get(filePath);
  if (existing) return existing;
  const created = createNoVisionModelCache(filePath);
  noVisionCacheByFilePath.set(filePath, created);
  return created;
}

async function createNoVisionModelCache(filePath: string): Promise<NoVisionModelCache> {
  const known = new Set<string>();
  let dirty = false;

  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as NoVisionCacheFile;
    if (Array.isArray(parsed.models)) {
      for (const entry of parsed.models) {
        if (typeof entry === "string" && entry.length > 0) known.add(entry);
      }
    }
  } catch {
    // 文件不存在或损坏都从空缓存开始；写入失败也只降级为进程内缓存。
  }

  const persist = async (): Promise<void> => {
    if (!dirty) return;
    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(
        filePath,
        `${JSON.stringify({ models: [...known] }, null, 2)}\n`,
        "utf-8",
      );
      dirty = false;
    } catch {
      // 落盘失败不影响本进程的判定；下次 add 时重试。
    }
  };

  return {
    has(providerId: string, modelId: string): boolean {
      return known.has(noVisionCacheKey(providerId, modelId));
    },
    add(providerId: string, modelId: string): void {
      if (known.has(noVisionCacheKey(providerId, modelId))) return;
      known.add(noVisionCacheKey(providerId, modelId));
      dirty = true;
      void persist();
    },
  };
}

// -----------------------------------------------
// 消息内 image block 的收集与替换
// -----------------------------------------------

export interface VisionFallbackImageRef {
  messageIndex: number;
  blockIndex: number;
  block: Extract<ModelMessageContentBlock, { type: "image" }>;
}

export function collectImageBlocks(messages: ModelInputMessage[]): VisionFallbackImageRef[] {
  const refs: VisionFallbackImageRef[] = [];
  messages.forEach((message, messageIndex) => {
    if (!Array.isArray(message.content)) return;
    message.content.forEach((block, blockIndex) => {
      if (block.type === "image" && typeof block.dataUrl === "string" && block.dataUrl.length > 0) {
        refs.push({ block, blockIndex, messageIndex });
      }
    });
  });
  return refs;
}

export function messagesContainImageBlocks(messages: ModelInputMessage[]): boolean {
  return collectImageBlocks(messages).length > 0;
}

export function formatBridgedImageDescription(modelId: string, description: string): string {
  return `[图片描述（由 ${modelId} 桥接）] ${description}`;
}

export function formatUnavailableImagePlaceholder(reason: string): string {
  return `[图片无法描述: ${reason}]`;
}

export function visionFallbackImageKey(ref: VisionFallbackImageRef): string {
  return `${ref.messageIndex}:${ref.blockIndex}`;
}

/**
 * 把消息中所有 image block 替换为对应文字块；未拿到描述的图替换为占位。
 * 纯函数：返回新消息数组，文本块/工具消息结构与 cacheControl 原样保留。
 */
export function replaceImageBlocksInMessages(
  messages: ModelInputMessage[],
  describe: (ref: VisionFallbackImageRef) => string,
): ModelInputMessage[] {
  let changed = false;
  const nextMessages = messages.map((message, messageIndex) => {
    if (!Array.isArray(message.content)) return message;
    let messageChanged = false;
    const content = message.content.map((block, blockIndex): ModelMessageContentBlock => {
      if (block.type !== "image") return block;
      const text = describe({ block, blockIndex, messageIndex });
      messageChanged = true;
      return { type: "text", text };
    });
    if (!messageChanged) return message;
    changed = true;
    return {
      ...message,
      ...(message.cacheControl ? { cacheControl: { ...message.cacheControl } } : {}),
      content,
    };
  });
  return changed ? nextMessages : messages;
}

// -----------------------------------------------
// 桥接编排（逐张串行，失败降级占位，不允许挂死 turn）
// -----------------------------------------------

export interface VisionFallbackBridgeOutcome {
  messages: ModelInputMessage[];
  bridgedCount: number;
  failedCount: number;
}

export async function bridgeImageBlocksInMessages(input: {
  fallbackModelId: string;
  fallbackProviderId: string;
  logger?: Logger;
  messages: ModelInputMessage[];
  port: VisionBridgePort;
}): Promise<VisionFallbackBridgeOutcome> {
  const imageRefs = collectImageBlocks(input.messages);
  if (imageRefs.length === 0) {
    return { bridgedCount: 0, failedCount: 0, messages: input.messages };
  }

  const descriptions = new Map<string, string>();
  const failures = new Map<string, string>();
  for (const ref of imageRefs) {
    const request: VisionBridgeImageRequest = {
      imageDataUrl: ref.block.dataUrl,
      mediaType: ref.block.mediaType,
      modelId: input.fallbackModelId,
      providerId: input.fallbackProviderId,
    };
    const key = visionFallbackImageKey(ref);
    try {
      const result = await input.port.describeImage(request);
      if (result.ok) {
        descriptions.set(key, result.description);
      } else {
        failures.set(key, result.reason);
        input.logger?.warn("Vision bridge description failed for image", {
          event: "model.vision_fallback.image_failed",
          fallbackModelId: input.fallbackModelId,
          module: "core.runtime",
          reason: result.reason,
        });
      }
    } catch (error) {
      // 端口实现约定不抛错；这里兜底保证单图异常绝不挂死 turn。
      const reason = error instanceof Error ? error.message : String(error);
      failures.set(key, reason);
      input.logger?.warn("Vision bridge port threw unexpectedly", {
        event: "model.vision_fallback.image_threw",
        fallbackModelId: input.fallbackModelId,
        module: "core.runtime",
        reason,
      });
    }
  }

  const messages = replaceImageBlocksInMessages(input.messages, (ref) => {
    const key = visionFallbackImageKey(ref);
    const description = descriptions.get(key);
    if (description !== undefined) {
      return formatBridgedImageDescription(input.fallbackModelId, description);
    }
    return formatUnavailableImagePlaceholder(failures.get(key) ?? "桥接请求失败");
  });
  const bridgedCount = descriptions.size;
  const failedCount = imageRefs.length - bridgedCount;
  return { bridgedCount, failedCount, messages };
}

/** fallback 未配置时的错误增强文案：保留原文，附可操作指引。 */
export function buildVisionFallbackGuidanceMessage(originalMessage: string): string {
  return [
    originalMessage,
    "该模型可能不支持图片输入。可在 设置→模型设置→视觉桥接 配置 fallback 视觉模型，或改用支持视觉的模型。",
  ].join("\n");
}
