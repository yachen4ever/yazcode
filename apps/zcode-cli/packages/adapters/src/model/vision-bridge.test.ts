import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildVisionBridgeChatCompletionsBody,
  parseVisionBridgeChatCompletionsDescription,
  requestVisionBridgeDescription,
  resolveVisionBridgeChatCompletionsUrl,
  VISION_BRIDGE_MAX_OUTPUT_TOKENS,
  VISION_BRIDGE_TIMEOUT_MS,
} from "./vision-bridge.js";

const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("vision-bridge", () => {
  it("URL 规范化：base 以 /v1 结尾则原样拼 /chat/completions", () => {
    assert.equal(
      resolveVisionBridgeChatCompletionsUrl("https://gw.example/v1"),
      "https://gw.example/v1/chat/completions",
    );
    // 尾部斜杠归一化，不产生 //chat/completions。
    assert.equal(
      resolveVisionBridgeChatCompletionsUrl("https://gw.example/v1/"),
      "https://gw.example/v1/chat/completions",
    );
  });

  it("URL 规范化：base 不带 /v1 则补 /v1 再拼接", () => {
    assert.equal(
      resolveVisionBridgeChatCompletionsUrl("https://gw.example"),
      "https://gw.example/v1/chat/completions",
    );
    assert.equal(
      resolveVisionBridgeChatCompletionsUrl("https://gw.example/"),
      "https://gw.example/v1/chat/completions",
    );
  });

  it("请求构造：data URL 进 image_url，max_tokens 与超时取约定常量", () => {
    const body = buildVisionBridgeChatCompletionsBody({
      imageDataUrl: PNG_DATA_URL,
      modelId: "qwen38",
    });
    assert.equal(body.model, "qwen38");
    assert.equal(body.max_tokens, VISION_BRIDGE_MAX_OUTPUT_TOKENS);
    assert.ok(VISION_BRIDGE_MAX_OUTPUT_TOKENS > 0);
    assert.ok(VISION_BRIDGE_TIMEOUT_MS > 0);
    const messages = body.messages as Array<Record<string, unknown>>;
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.role, "user");
    const content = messages[0]?.content as Array<Record<string, unknown>>;
    assert.deepEqual(
      content.map((part) => part.type),
      ["text", "image_url"],
    );
    const imageUrl = content[1]?.image_url as { url: string };
    assert.equal(imageUrl.url, PNG_DATA_URL);
  });

  it("响应解析：取 choices[0].message.content 字符串，分段 content 拼 text", () => {
    assert.equal(
      parseVisionBridgeChatCompletionsDescription({
        choices: [{ message: { content: "一只猫" } }],
      }),
      "一只猫",
    );
    assert.equal(
      parseVisionBridgeChatCompletionsDescription({
        choices: [{ message: { content: [{ text: "一只" }, { text: "猫" }, { type: "other" }] } }],
      }),
      "一只猫",
    );
    // 空串、缺 choices、缺 message 都不算有效描述。
    assert.equal(
      parseVisionBridgeChatCompletionsDescription({ choices: [{ message: { content: "  " } }] }),
      undefined,
    );
    assert.equal(parseVisionBridgeChatCompletionsDescription({ choices: [] }), undefined);
    assert.equal(parseVisionBridgeChatCompletionsDescription("nope"), undefined);
    assert.equal(parseVisionBridgeChatCompletionsDescription(undefined), undefined);
  });

  it("多图逐张：每张图片各发一次请求，互不影响", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const responses = ["第一张图", "第二张图"];
    let call = 0;
    const describe = async (imageDataUrl: string): Promise<string> => {
      return requestVisionBridgeDescription({
        baseUrl: "https://gw.example/v1",
        fetch: (async (_input, init) => {
          requestBodies.push(JSON.parse(String(init?.body)));
          const description = responses[call];
          call += 1;
          return new Response(
            JSON.stringify({ choices: [{ message: { content: description } }] }),
            { headers: { "content-type": "application/json" }, status: 200 },
          );
        }) as typeof fetch,
        imageDataUrl,
        modelId: "qwen38",
      });
    };
    const first = await describe("data:image/png;base64,AAAA");
    const second = await describe("data:image/png;base64,BBBB");
    assert.equal(first, "第一张图");
    assert.equal(second, "第二张图");
    assert.equal(requestBodies.length, 2);
    const firstImage = (requestBodies[0]?.messages as Array<Record<string, unknown>>)[0]
      ?.content as Array<Record<string, unknown>>;
    assert.equal(
      (firstImage[1]?.image_url as { url: string }).url,
      "data:image/png;base64,AAAA",
    );
  });

  it("非 2xx 抛错且携带状态码与原因；网络错误包装为可读失败", async () => {
    await assert.rejects(
      requestVisionBridgeDescription({
        baseUrl: "https://gw.example",
        fetch: (async () =>
          new Response(JSON.stringify({ error: { message: "bad gateway" } }), { status: 502 })) as
            typeof fetch,
        imageDataUrl: PNG_DATA_URL,
        modelId: "qwen38",
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /HTTP 502/);
        assert.match(error.message, /bad gateway/);
        return true;
      },
    );

    await assert.rejects(
      requestVisionBridgeDescription({
        baseUrl: "https://gw.example",
        fetch: (async () => {
          throw new Error("ECONNREFUSED");
        }) as typeof fetch,
        imageDataUrl: PNG_DATA_URL,
        modelId: "qwen38",
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /vision bridge request failed/);
        assert.match(error.message, /ECONNREFUSED/);
        return true;
      },
    );
  });

  it("2xx 但无描述内容同样视为失败，编排层可据此替换占位", async () => {
    await assert.rejects(
      requestVisionBridgeDescription({
        baseUrl: "https://gw.example/v1",
        fetch: (async () =>
          new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), {
            status: 200,
          })) as typeof fetch,
        imageDataUrl: PNG_DATA_URL,
        modelId: "qwen38",
      }),
      /did not contain a text description/,
    );
  });
});
