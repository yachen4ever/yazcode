import { Readable } from "node:stream";
import type http from "node:http";
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  readIncomingResponse,
  toWebResponse,
  UNSUPPORTED_HTTP_STATUS_CODE,
  UnsupportedHttpStatusError,
} from "./incoming-response.js";

/** 造一个够真的 IncomingMessage：有 body 流、状态码与 headers。 */
function fakeIncoming(
  statusCode: number | undefined,
  options: { body?: string; statusMessage?: string } = {},
): http.IncomingMessage & { resume: ReturnType<typeof mock.fn> } {
  // 真实 IncomingMessage 发的是 Buffer，不是字符串（否则 Response 会拒收 chunk）。
  const stream = Readable.from([
    Buffer.from(options.body ?? ""),
  ]) as unknown as http.IncomingMessage;
  Object.assign(stream, {
    headers: { "content-type": "text/plain", "x-multi": ["a", "b"] },
    statusCode,
    statusMessage: options.statusMessage,
  });
  // spy 而不是替换：`Readable.toWeb` 依赖底层流的真实 resume 行为。
  const resume = mock.method(stream, "resume");
  return stream as http.IncomingMessage & { resume: ReturnType<typeof mock.fn> };
}

describe("incoming-response", () => {
  it("原样读出状态码与 headers（多值头保留）", () => {
    const incoming = readIncomingResponse(fakeIncoming(999, { statusMessage: "Nonstandard" }));
    assert.equal(incoming.status, 999);
    assert.equal(incoming.statusText, "Nonstandard");
    assert.equal(incoming.headers.get("content-type"), "text/plain");
    assert.equal(incoming.headers.get("x-multi"), "a, b");
    assert.notEqual(incoming.body, null);
  });

  it("Response 表示不了的状态码抛可辨识的 TypeError，而不是在回调里炸出 RangeError", () => {
    const incoming = readIncomingResponse(fakeIncoming(999));
    assert.throws(() => toWebResponse(incoming), UnsupportedHttpStatusError);
    try {
      toWebResponse(incoming);
    } catch (error) {
      // 形状跟随原生 fetch 的网络失败：按错误码区分，不看文本。
      assert.ok(error instanceof TypeError);
      assert.equal((error as UnsupportedHttpStatusError).code, UNSUPPORTED_HTTP_STATUS_CODE);
      assert.equal((error as UnsupportedHttpStatusError).status, 999);
    }
  });

  it("无正文状态不挂流，并把消息读完以便 socket 回连接池", () => {
    const message = fakeIncoming(204);
    const incoming = readIncomingResponse(message);
    assert.equal(incoming.status, 204);
    assert.equal(incoming.body, null);
    assert.notEqual(message.resume.mock.callCount(), 0);
    assert.equal(toWebResponse(incoming).body, null);
  });

  it("正常状态交给 Response，状态码与文本原样透传", async () => {
    const incoming = readIncomingResponse(
      fakeIncoming(201, { body: "hello", statusMessage: "Created" }),
    );
    const response = toWebResponse(incoming);
    assert.equal(response.status, 201);
    assert.equal(response.statusText, "Created");
    assert.equal(await response.text(), "hello");
  });

  it("缺失状态码按 502 对待（仍是可表示的区间）", () => {
    const incoming = readIncomingResponse(fakeIncoming(undefined));
    assert.equal(incoming.status, 502);
    assert.equal(toWebResponse(incoming).status, 502);
  });

  it("1xx 与 600+ 都拒绝", () => {
    for (const status of [100, 101, 199, 600, 1000]) {
      assert.throws(() => toWebResponse(readIncomingResponse(fakeIncoming(status))), UnsupportedHttpStatusError);
    }
  });
});
