import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ModelApiActorKind, ModelApiOperation, ModelRequestSessionType } from "@zcode/contracts";
import {
  PROTECTED_PROVIDER_HEADER_NAMES,
  PROVIDER_SESSION_ID_PLACEHOLDER,
  resolveProviderRequestHeaders,
} from "./provider-request-headers.js";
import { createModelRequestAttributionHeaders } from "./runner-status.js";
import type { ModelStatusContext } from "./runner-status.js";

/**
 * Provider 自定义请求头（api.headers）解析语义（26.5.10，issue #36，
 * spec docs/specs/provider-custom-headers.md）：
 * - `{{sessionId}}` → 当前会话 ID（口径同归因头 strip sess_/subagent_agent_ 前缀；
 *   每会话稳定、非每请求随机）；
 * - 未知占位符 / 无会话 ID 时占位符原样保留；静态值不变；
 * - 保护头（Authorization 等）丢弃并返回清单；
 * - 官方 URL 的 x-opencode-session 自动注入行为不变。
 */

function makeStatusContext(overrides: Partial<ModelStatusContext> = {}): ModelStatusContext {
  return {
    traceId: "trace-test" as ModelStatusContext["traceId"],
    requestId: "req-test",
    providerId: "provider-test" as ModelStatusContext["providerId"],
    modelId: "model-test" as ModelStatusContext["modelId"],
    modelRequestSessionType: ModelRequestSessionType.Main,
    transport: "stdio",
    maxAttempts: 1,
    modelCall: {
      actorKind: ModelApiActorKind.MainAgent,
      operation: ModelApiOperation.AgentStep,
    },
    ...overrides,
  } as ModelStatusContext;
}

describe("resolveProviderRequestHeaders：会话占位符（#36）", () => {
  it("同会话两次解析值相同且等于 strip 前缀后的会话 ID；不同会话不同", () => {
    const headers = { "x-opencode-session": PROVIDER_SESSION_ID_PLACEHOLDER };
    const sessionA = makeStatusContext({ sessionId: "sess_abc123" as never });
    const sessionB = makeStatusContext({ sessionId: "sess_def456" as never });
    const first = resolveProviderRequestHeaders(headers, sessionA);
    const second = resolveProviderRequestHeaders(headers, sessionA);
    const other = resolveProviderRequestHeaders(headers, sessionB);
    assert.equal(first.headers["x-opencode-session"], "abc123");
    assert.equal(second.headers["x-opencode-session"], "abc123");
    assert.equal(other.headers["x-opencode-session"], "def456");
    assert.notEqual(
      first.headers["x-opencode-session"],
      other.headers["x-opencode-session"],
    );
  });

  it("子代理内部前缀同样被剥离（口径与归因头一致）", () => {
    const resolved = resolveProviderRequestHeaders(
      { "x-opencode-session": PROVIDER_SESSION_ID_PLACEHOLDER },
      makeStatusContext({ sessionId: "subagent_agent_xyz789" as never }),
    );
    assert.equal(resolved.headers["x-opencode-session"], "xyz789");
  });

  it("静态头（无占位符）原样输出", () => {
    const resolved = resolveProviderRequestHeaders(
      { "x-static": "fixed-value", "X-Mixed-Case": "Case" },
      makeStatusContext({ sessionId: "sess_abc" as never }),
    );
    assert.deepEqual(resolved.headers, { "x-static": "fixed-value", "X-Mixed-Case": "Case" });
  });

  it("未知占位符原样保留", () => {
    const resolved = resolveProviderRequestHeaders(
      { "x-custom": "prefix-{{foo}}-suffix" },
      makeStatusContext({ sessionId: "sess_abc" as never }),
    );
    assert.equal(resolved.headers["x-custom"], "prefix-{{foo}}-suffix");
  });

  it("无会话 ID 时 {{sessionId}} 原样保留（不产生空头值）", () => {
    const resolved = resolveProviderRequestHeaders(
      { "x-opencode-session": PROVIDER_SESSION_ID_PLACEHOLDER },
      makeStatusContext(),
    );
    assert.equal(resolved.headers["x-opencode-session"], PROVIDER_SESSION_ID_PLACEHOLDER);
  });

  it("多个占位符与多处出现全部替换", () => {
    const resolved = resolveProviderRequestHeaders(
      { "x-a": "{{sessionId}}:{{sessionId}}", "x-b": "v-{{sessionId}}" },
      makeStatusContext({ sessionId: "sess_s1" as never }),
    );
    assert.equal(resolved.headers["x-a"], "s1:s1");
    assert.equal(resolved.headers["x-b"], "v-s1");
  });
});

describe("resolveProviderRequestHeaders：保护头（#36）", () => {
  it("Authorization/Host/Content-Type 等被丢弃并返回原始名（大小写不敏感）", () => {
    const resolved = resolveProviderRequestHeaders(
      {
        Authorization: "Bearer leaked",
        host: "evil.example",
        "Content-Type": "text/plain",
        "content-length": "123",
        Cookie: "a=b",
        "content-encoding": "gzip",
        "x-opencode-session": PROVIDER_SESSION_ID_PLACEHOLDER,
      },
      makeStatusContext({ sessionId: "sess_s1" as never }),
    );
    assert.deepEqual(resolved.droppedProtectedHeaders.sort(), [
      "Authorization",
      "Content-Type",
      "Cookie",
      "content-encoding",
      "content-length",
      "host",
    ]);
    assert.deepEqual(resolved.headers, { "x-opencode-session": "s1" });
  });

  it("保护头名单与 new-api 插件口径一致（六项）", () => {
    assert.deepEqual(
      [...PROTECTED_PROVIDER_HEADER_NAMES].sort(),
      ["authorization", "content-encoding", "content-length", "content-type", "cookie", "host"],
    );
  });

  it("无 provider headers 时返回空集与空清单", () => {
    const resolved = resolveProviderRequestHeaders(undefined, makeStatusContext());
    assert.deepEqual(resolved, { headers: {}, droppedProtectedHeaders: [] });
  });
});

describe("请求归因头回归：官方 URL 自动注入（#36 判据）", () => {
  it("官方 OpenCode Go URL 注入 x-opencode-session = 会话 ID", () => {
    const headers = createModelRequestAttributionHeaders(
      makeStatusContext({
        sessionId: "sess_abc" as never,
        baseURL: "https://opencode.ai/zen/go/v1",
      }),
    );
    assert.equal(headers["x-opencode-session"], "abc");
  });

  it("自建网关 URL 不注入 x-opencode-session（由 provider 占位符头补齐）", () => {
    const headers = createModelRequestAttributionHeaders(
      makeStatusContext({
        sessionId: "sess_abc" as never,
        baseURL: "http://192.168.5.7:3001",
      }),
    );
    assert.equal("x-opencode-session" in headers, false);
  });
});

describe("端到端 smoke：解析后的头值经网络到达 mock server（#36 判据）", () => {
  const received: Record<string, string | string[] | undefined>[] = [];
  let port = 0;
  let closeServer: (() => Promise<void>) | undefined;

  before(async () => {
    const server = createServer((req, res) => {
      received.push({ ...req.headers });
      res.statusCode = 204;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
    closeServer = () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  });

  after(async () => {
    await closeServer?.();
  });

  it("会话头占位符替换后服务端收到会话 ID；保护头不发出", async () => {
    const resolved = resolveProviderRequestHeaders(
      {
        "x-opencode-session": PROVIDER_SESSION_ID_PLACEHOLDER,
        Authorization: "Bearer leaked",
      },
      makeStatusContext({ sessionId: "sess_e2e-session" as never }),
    );
    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { ...resolved.headers, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 204);
    const last = received.at(-1)!;
    assert.equal(last["x-opencode-session"], "e2e-session");
    assert.equal(last["authorization"], undefined);
  });
});
