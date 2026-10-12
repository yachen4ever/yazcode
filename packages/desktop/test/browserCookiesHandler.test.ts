import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ControlledView } from "../src/browserView/browserCommandTypes.js";
import { handleCookies } from "../src/main/browserView/browserCommandCookiesHandler.js";

type ThrowHook = (method: string, params: unknown) => Error | undefined;

/** 受控假 CDP：记录 sendCommand 调用，按预设脚本返回；throwOn 决定哪些调用抛错。 */
function fakeView(
  script: Map<string, unknown>,
  throwOn?: ThrowHook,
): ControlledView & { _sent: { method: string; params: unknown }[] } {
  const sent: { method: string; params: unknown }[] = [];
  return {
    webContents: {} as ControlledView["webContents"],
    cdp: {
      async send(method: string, params?: unknown) {
        sent.push({ method, params });
        const thrownError = throwOn?.(method, params);
        if (thrownError) throw thrownError;
        return script.get(method);
      },
    },
    _sent: sent,
  } as ControlledView & { _sent: { method: string; params: unknown }[] };
}

const done =
  (partial: Omit<import("@zcode/shared").BrowserCommandResult, "elapsedMs">) => partial;

describe("handleCookies", () => {
  it("get 返回 Storage.getCookies 的 cookies 数组", async () => {
    const cookies = [
      { name: "_AIOPS_SESSION_", value: "abc", domain: "oa.example.com", path: "/", httpOnly: true },
    ];
    const view = fakeView(new Map([["Storage.getCookies", { cookies }]]));
    const result = await handleCookies(
      view,
      { method: "cookies", action: { name: "get" } },
      done,
    );
    assert.equal(result.ok, true);
    assert.deepEqual((result as { value?: { cookies: unknown[] } }).value?.cookies, cookies);
  });

  it("set 逐条调用 Storage.setCookies，全部成功时 failed 为空", async () => {
    const view = fakeView(new Map());
    const result = await handleCookies(
      view,
      {
        method: "cookies",
        action: {
          name: "set",
          cookies: [
            { name: "a", value: "1", domain: "oa.example.com", path: "/" },
            { name: "b", value: "2", url: "https://oa.example.com/" },
          ],
        },
      },
      done,
    );
    assert.equal(result.ok, true);
    const value = (result as { value?: { set: number; failed: unknown[] } }).value;
    assert.equal(value?.set, 2);
    assert.equal(value?.failed.length, 0);
    const sent = (view as { _sent: { method: string; params: unknown }[] })._sent;
    assert.equal(sent.length, 2);
    assert.equal(sent[0].method, "Storage.setCookies");
  });

  it("单条失败进 failed，不影响其余条目（部分失败可定位）", async () => {
    const view = fakeView(new Map(), (method, params) => {
      // 只让第二条（bad）抛错，验证逐条隔离。
      const cookie = (params as { cookies?: { name?: string }[] })?.cookies?.[0];
      return cookie?.name === "bad" ? new Error("boom") : undefined;
    });
    const result = await handleCookies(
      view,
      {
        method: "cookies",
        action: {
          name: "set",
          cookies: [
            { name: "good", value: "1", domain: "d.test", path: "/" },
            { name: "bad", value: "2", domain: "d.test", path: "/" },
          ],
        },
      },
      done,
    );
    const value = (result as { value?: { set: number; failed: { index: number; name: string }[] } })
      .value;
    assert.equal(value?.set, 1);
    assert.equal(value?.failed.length, 1);
    assert.equal(value?.failed[0].index, 1);
    assert.equal(value?.failed[0].name, "bad");
  });

  it("运行时兜底校验：绕过 schema 的非法条目进 failed", async () => {
    const view = fakeView(new Map());
    const result = await handleCookies(
      view,
      {
        method: "cookies",
        action: {
          name: "set",
          // 手拼请求可能绕过 zod；handler 内校验兜底。
          cookies: [{ name: "no-location", value: "x" } as never],
        },
      },
      done,
    );
    const value = (result as { value?: { set: number; failed: { error: string }[] } }).value;
    assert.equal(value?.set, 0);
    assert.match(value?.failed[0].error ?? "", /invalid cookie param/);
  });
});
