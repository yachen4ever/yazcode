import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Logger, Model, ModelInputFormat, ModelInputMessage } from "@zcode/contracts";
import { createMessageId, createRootTraceContext } from "@zcode/contracts";
import type { VisionBridgeImageRequest, VisionBridgePort } from "@zcode/contracts";
import { runModelTextRequest } from "../../src/runtime/methods/model.js";
import type { AgentRuntimeInternal } from "../../src/runtime/internal.js";
import type { RunModelTextRequestOptions, RuntimeModelTextResult } from "../../src/runtime/types.js";
import {
  formatBridgedImageDescription,
  formatUnavailableImagePlaceholder,
  isMultimodalRejectionError,
  loadNoVisionModelCache,
  matchesMultimodalRejectionText,
  messagesContainImageBlocks,
  replaceImageBlocksInMessages,
} from "../../src/runtime/helpers/vision-fallback.js";

const IMAGE_PNG = "data:image/png;base64,AAAA";
const MULTIMODAL_ERROR = "HTTP 400: dsv4 is not a multimodal model";

type ArrayContent = Extract<NonNullable<ModelInputMessage["content"]>, unknown[]>;

function userMessageWithImage(): ModelInputMessage {
  return {
    content: [
      { type: "text", text: "看这张图" },
      { type: "image", mediaType: "image/png", dataUrl: IMAGE_PNG },
    ],
    role: "user",
  };
}

const SUPPORTS_ALL: ModelInputFormat = {
  supportsAudio: false,
  supportsImage: true,
  supportsPdf: true,
  supportsText: true,
  supportsVideo: true,
};

interface RecordedModelRequest {
  messages: ModelInputMessage[];
}

function createFakeModel(behavior: (request: RecordedModelRequest) => Promise<Partial<RuntimeModelTextResult>>): {
  model: Model;
  requests: RecordedModelRequest[];
} {
  const requests: RecordedModelRequest[] = [];
  const model = {
    generateText: async (request: RecordedModelRequest) => {
      requests.push({ messages: request.messages });
      return behavior(request);
    },
    modelId: "dsv4",
    properties: { inputFormat: SUPPORTS_ALL },
    providerId: "gw",
  } as unknown as Model;
  return { model, requests };
}

function createFakeRuntime(input: {
  cacheFilePath?: string;
  port?: VisionBridgePort;
  visionFallback?: { enabled?: boolean; providerId?: string; modelId?: string };
}): AgentRuntimeInternal {
  return {
    agentTelemetry: { actorKind: "main" },
    artifactStore: undefined,
    buildContextUsageBreakdownFromSnapshot: () => [],
    buildContextUsageSnapshot: () => ({}),
    config: {
      ...(input.cacheFilePath || input.visionFallback
        ? {
            visionFallback: {
              ...(input.cacheFilePath ? { cacheFilePath: input.cacheFilePath } : {}),
              ...(input.visionFallback ?? {}),
            },
          }
        : {}),
    },
    createModelStatusSink: () => ({ publish: () => {} }),
    logContextUsageSnapshot: () => {},
    logger: undefined as unknown as Logger,
    shouldStreamModelText: () => false,
    visionBridgePort: input.port,
  } as unknown as AgentRuntimeInternal;
}

function createPort(
  results: Array<{ ok: true; description: string } | { ok: false; reason: string }>,
): { calls: VisionBridgeImageRequest[]; port: VisionBridgePort } {
  const calls: VisionBridgeImageRequest[] = [];
  let index = 0;
  return {
    calls,
    port: {
      describeImage: async (request) => {
        calls.push(request);
        const result = results[Math.min(index, results.length - 1)];
        index += 1;
        return result;
      },
    },
  };
}

function createOptions(model: Model, messages: ModelInputMessage[]): RunModelTextRequestOptions {
  return {
    assistantMessageId: createMessageId(),
    events: [],
    messages,
    model,
    tools: [],
    traceContext: createRootTraceContext({ sessionId: createMessageId() }),
  };
}

function okResult(text: string): Partial<RuntimeModelTextResult> {
  return { finishReason: "stop", text, toolCalls: undefined, usage: {} };
}

function requestHasImage(request: RecordedModelRequest | undefined): boolean {
  const content = request?.messages[0]?.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => block.type === "image");
}

async function withTempCacheFile(
  seed?: string,
): Promise<{ cleanup: () => Promise<void>; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "vision-fallback-test-"));
  const path = join(dir, "no-vision-models.json");
  if (seed !== undefined) {
    await writeFile(path, seed, "utf-8");
  }
  return { cleanup: () => rm(dir, { recursive: true, force: true }), path };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(await predicate(), "条件在超时前未满足");
}

describe("vision-fallback 特征识别", () => {
  it("各特征串命中且大小写不敏感", () => {
    assert.ok(matchesMultimodalRejectionText("dsv4 is not a multimodal model"));
    assert.ok(matchesMultimodalRejectionText("This model does not support image input"));
    assert.ok(matchesMultimodalRejectionText("image not support by this endpoint"));
    assert.ok(matchesMultimodalRejectionText("Unsupported image format"));
    assert.ok(matchesMultimodalRejectionText("NOT A MULTIMODAL MODEL"));
    assert.ok(matchesMultimodalRejectionText("glm-5 is not a Multimodal Model"));
  });

  it("非命中文本与非字符串输入一律不命中", () => {
    assert.equal(matchesMultimodalRejectionText("context length exceeded"), false);
    assert.equal(matchesMultimodalRejectionText("invalid api key"), false);
    assert.equal(matchesMultimodalRejectionText(""), false);
    assert.equal(matchesMultimodalRejectionText(undefined), false);
    assert.equal(matchesMultimodalRejectionText(null), false);
    assert.equal(matchesMultimodalRejectionText(42), false);
    assert.equal(matchesMultimodalRejectionText({ message: "x" }), false);
  });

  it("错误识别沿 message/responseBody/cause 链匹配", () => {
    assert.ok(isMultimodalRejectionError(new Error(MULTIMODAL_ERROR)));
    assert.ok(
      isMultimodalRejectionError(
        Object.assign(new Error("request failed"), {
          responseBody: "dsv4 Is Not a Multimodal Model",
        }),
      ),
    );
    const nested = new Error("outer", {
      cause: new Error("inner: glm-5 is not a multimodal model"),
    });
    assert.ok(isMultimodalRejectionError(nested));
    assert.equal(isMultimodalRejectionError(new Error("rate limited")), false);
    assert.equal(isMultimodalRejectionError(undefined), false);
  });
});

describe("无视觉缓存", () => {
  it("add 后进程内可见并持久化落盘", async () => {
    const { cleanup, path } = await withTempCacheFile();
    try {
      const cache = await loadNoVisionModelCache(path);
      assert.equal(cache.has("gw", "dsv4"), false);
      cache.add("gw", "dsv4");
      assert.equal(cache.has("gw", "dsv4"), true);
      await waitFor(async () => {
        try {
          const raw = JSON.parse(await readFile(path, "utf-8")) as { models?: string[] };
          return Array.isArray(raw.models) && raw.models.includes("gw\u0000dsv4");
        } catch {
          return false;
        }
      });
    } finally {
      await cleanup();
    }
  });

  it("文件损坏时回退空缓存继续工作，不抛错", async () => {
    const { cleanup, path } = await withTempCacheFile("{ this is not json");
    try {
      const cache = await loadNoVisionModelCache(path);
      assert.equal(cache.has("gw", "dsv4"), false);
      cache.add("gw", "dsv4");
      assert.equal(cache.has("gw", "dsv4"), true);
    } finally {
      await cleanup();
    }
  });
});

describe("消息变换", () => {
  it("单图替换为桥接描述文本，文本块原样保留", () => {
    const messages = [userMessageWithImage()];
    const next = replaceImageBlocksInMessages(messages, () =>
      formatBridgedImageDescription("qwen38", "一只猫坐在桌上"),
    );
    assert.notEqual(next, messages);
    const content = next[0]?.content as ArrayContent;
    assert.equal(content.length, 2);
    assert.deepEqual(content[0], { type: "text", text: "看这张图" });
    assert.deepEqual(content[1], {
      type: "text",
      text: formatBridgedImageDescription("qwen38", "一只猫坐在桌上"),
    });
  });

  it("多图与混合文本全部替换，未拿到的图替换占位", () => {
    const messages: ModelInputMessage[] = [
      {
        content: [
          { type: "text", text: "两张图" },
          { type: "image", mediaType: "image/png", dataUrl: IMAGE_PNG },
          { type: "image", mediaType: "image/jpeg", dataUrl: "data:image/jpeg;base64,BBBB" },
        ],
        role: "user",
      },
      { content: "纯文本消息", role: "user" },
    ];
    let call = 0;
    const next = replaceImageBlocksInMessages(messages, () => {
      call += 1;
      return call === 1
        ? formatBridgedImageDescription("qwen38", "第一张图")
        : formatUnavailableImagePlaceholder("桥接请求失败");
    });
    const firstContent = next[0]?.content as ArrayContent;
    assert.equal(firstContent.length, 3);
    assert.ok(firstContent.every((block) => block.type === "text"));
    assert.match(String((firstContent[1] as { text: string }).text), /第一张图/);
    assert.match(String((firstContent[2] as { text: string }).text), /图片无法描述/);
    // 纯文本消息原样保留（同一引用）。
    assert.equal(next[1], messages[1]);
  });

  it("messagesContainImageBlocks 识别含图与不含图的消息", () => {
    assert.ok(messagesContainImageBlocks([userMessageWithImage()]));
    assert.equal(messagesContainImageBlocks([{ content: "纯文本", role: "user" }]), false);
    assert.equal(
      messagesContainImageBlocks([{ content: [{ type: "text", text: "x" }], role: "user" }]),
      false,
    );
  });
});

describe("视觉桥接编排（runModelTextRequest）", () => {
  it("场景 2：首次贴图试错一次 → 自动桥接 → 重试成功，重试请求不含图片", async () => {
    const { cleanup, path } = await withTempCacheFile();
    try {
      const { calls, port } = createPort([{ ok: true, description: "一只猫坐在桌上" }]);
      const { model, requests } = createFakeModel(async (request) => {
        if (requestHasImage(request)) throw new Error(MULTIMODAL_ERROR);
        return okResult("图里是一只猫");
      });
      const runtime = createFakeRuntime({
        cacheFilePath: path,
        port,
        visionFallback: { enabled: true, modelId: "qwen38", providerId: "gw" },
      });
      const result = await runModelTextRequest.call(
        runtime,
        createOptions(model, [userMessageWithImage()]),
      );

      assert.equal(result.text, "图里是一只猫");
      // 试错一次 + 重试一次。
      assert.equal(requests.length, 2);
      assert.ok(requestHasImage(requests[0]));
      assert.equal(requestHasImage(requests[1]), false);
      const retryContent = requests[1]?.messages[0]?.content as ArrayContent;
      assert.equal(
        (retryContent[1] as { text: string }).text,
        formatBridgedImageDescription("qwen38", "一只猫坐在桌上"),
      );
      // 桥接端口被调用一次，携带原始 data URL 与 fallback 模型身份。
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.imageDataUrl, IMAGE_PNG);
      assert.equal(calls[0]?.modelId, "qwen38");
    } finally {
      await cleanup();
    }
  });

  it("场景 3：缓存命中后直接桥接，不再发出原始请求", async () => {
    const { cleanup, path } = await withTempCacheFile();
    try {
      // 第一次调用：试错并写入缓存。
      const first = createPort([{ ok: true, description: "一只猫" }]);
      const firstModel = createFakeModel(async (request) => {
        if (requestHasImage(request)) throw new Error(MULTIMODAL_ERROR);
        return okResult("ok");
      });
      const firstRuntime = createFakeRuntime({
        cacheFilePath: path,
        port: first.port,
        visionFallback: { enabled: true, modelId: "qwen38", providerId: "gw" },
      });
      await runModelTextRequest.call(
        firstRuntime,
        createOptions(firstModel.model, [userMessageWithImage()]),
      );
      assert.equal(firstModel.requests.length, 2);

      // 第二次调用（新 runtime，同一缓存文件）：原始请求不发出，单次桥接直达。
      const second = createPort([{ ok: true, description: "第二张图" }]);
      const secondModel = createFakeModel(async () => okResult("直接成功"));
      const secondRuntime = createFakeRuntime({
        cacheFilePath: path,
        port: second.port,
        visionFallback: { enabled: true, modelId: "qwen38", providerId: "gw" },
      });
      const result = await runModelTextRequest.call(
        secondRuntime,
        createOptions(secondModel.model, [userMessageWithImage()]),
      );
      assert.equal(result.text, "直接成功");
      assert.equal(secondModel.requests.length, 1);
      assert.equal(requestHasImage(secondModel.requests[0]), false);
      assert.equal(second.calls.length, 1);
    } finally {
      await cleanup();
    }
  });

  it("场景 5：fallback 桥接失败 → 图片替换占位，turn 继续不挂死", async () => {
    const { cleanup, path } = await withTempCacheFile();
    try {
      const { calls, port } = createPort([{ ok: false, reason: "HTTP 503: upstream unavailable" }]);
      const { model, requests } = createFakeModel(async (request) => {
        if (requestHasImage(request)) throw new Error(MULTIMODAL_ERROR);
        return okResult("占位也继续");
      });
      const runtime = createFakeRuntime({
        cacheFilePath: path,
        port,
        visionFallback: { enabled: true, modelId: "qwen38", providerId: "gw" },
      });
      const result = await runModelTextRequest.call(
        runtime,
        createOptions(model, [userMessageWithImage()]),
      );

      assert.equal(result.text, "占位也继续");
      assert.equal(requests.length, 2);
      const retryContent = requests[1]?.messages[0]?.content as ArrayContent;
      assert.equal(
        (retryContent[1] as { text: string }).text,
        formatUnavailableImagePlaceholder("HTTP 503: upstream unavailable"),
      );
      assert.equal(calls.length, 1);
    } finally {
      await cleanup();
    }
  });

  it("场景 1 降级：fallback 未配置 → 不重试，错误含原文与配置指引", async () => {
    const { model, requests } = createFakeModel(async () => {
      throw new Error(MULTIMODAL_ERROR);
    });
    const runtime = createFakeRuntime({});
    await assert.rejects(
      runModelTextRequest.call(runtime, createOptions(model, [userMessageWithImage()])),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /dsv4 is not a multimodal model/);
        assert.match(error.message, /设置→模型设置→视觉桥接/);
        return true;
      },
    );
    assert.equal(requests.length, 1);
  });

  it("场景 4：视觉模型为主模型 → 不触发桥接，图片原样发出且不写缓存", async () => {
    const { cleanup, path } = await withTempCacheFile();
    try {
      const { calls, port } = createPort([{ ok: true, description: "不该被调用" }]);
      const { model, requests } = createFakeModel(async () => okResult("直接成功"));
      const runtime = createFakeRuntime({
        cacheFilePath: path,
        port,
        visionFallback: { enabled: true, modelId: "qwen38", providerId: "gw" },
      });
      const result = await runModelTextRequest.call(
        runtime,
        createOptions(model, [userMessageWithImage()]),
      );
      assert.equal(result.text, "直接成功");
      assert.equal(requests.length, 1);
      assert.ok(requestHasImage(requests[0]));
      assert.equal(calls.length, 0);
      // 无视觉事实未被错误记录。
      const cache = await loadNoVisionModelCache(path);
      assert.equal(cache.has("gw", "dsv4"), false);
    } finally {
      await cleanup();
    }
  });

  it("场景 8：未启用 visionFallback 时行为与普通请求一致", async () => {
    const { model, requests } = createFakeModel(async () => okResult("ok"));
    const runtime = createFakeRuntime({ visionFallback: { enabled: false } });
    const result = await runModelTextRequest.call(
      runtime,
      createOptions(model, [userMessageWithImage()]),
    );
    assert.equal(result.text, "ok");
    assert.equal(requests.length, 1);
  });

  it("重试后的再次失败不再进入第二次桥接（防循环）", async () => {
    const { cleanup, path } = await withTempCacheFile();
    try {
      const { port } = createPort([{ ok: true, description: "描述" }]);
      let attempts = 0;
      const { model } = createFakeModel(async (request) => {
        attempts += 1;
        // 首次多模态拒绝触发桥接；桥接重试后仍失败（非多模态错误），
        // 必须原样抛出而不是再次桥接。
        if (requestHasImage(request)) throw new Error(MULTIMODAL_ERROR);
        throw new Error("context length exceeded");
      });
      const runtime = createFakeRuntime({
        cacheFilePath: path,
        port,
        visionFallback: { enabled: true, modelId: "qwen38", providerId: "gw" },
      });
      await assert.rejects(
        runModelTextRequest.call(runtime, createOptions(model, [userMessageWithImage()])),
        /context length exceeded/,
      );
      assert.equal(attempts, 2);
    } finally {
      await cleanup();
    }
  });
});
