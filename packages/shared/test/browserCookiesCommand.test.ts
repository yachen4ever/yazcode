import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  browserCommandSchema,
  browserCookieParamSchema,
} from "@zcode/shared";

describe("browserCommandSchema cookies branch", () => {
  it("接受 cookies get 命令", () => {
    const parsed = browserCommandSchema.safeParse({
      method: "cookies",
      action: { name: "get" },
    });
    assert.equal(parsed.success, true);
  });

  it("接受带 tabId 的 cookies set 命令", () => {
    const parsed = browserCommandSchema.safeParse({
      method: "cookies",
      action: {
        name: "set",
        cookies: [
          { name: "_AIOPS_SESSION_", value: "token", domain: "oa.example.com", path: "/" },
        ],
      },
      tabId: "tab-1",
    });
    assert.equal(parsed.success, true);
  });

  it("拒绝空 cookies 数组（set 至少一条）", () => {
    const parsed = browserCommandSchema.safeParse({
      method: "cookies",
      action: { name: "set", cookies: [] },
    });
    assert.equal(parsed.success, false);
  });

  it("拒绝既无 url 又无 domain+path 的 cookie", () => {
    const parsed = browserCookieParamSchema.safeParse({ name: "sid", value: "v" });
    assert.equal(parsed.success, false);
  });

  it("url 或 domain+path 二选一均合法", () => {
    assert.equal(
      browserCookieParamSchema.safeParse({
        name: "sid",
        value: "v",
        url: "https://oa.example.com/",
      }).success,
      true,
    );
    assert.equal(
      browserCookieParamSchema.safeParse({
        name: "sid",
        value: "v",
        domain: "oa.example.com",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      }).success,
      true,
    );
  });

  it("拒绝未知字段（strict）", () => {
    const parsed = browserCookieParamSchema.safeParse({
      name: "sid",
      value: "v",
      domain: "oa.example.com",
      path: "/",
      evil: true,
    });
    assert.equal(parsed.success, false);
  });
});
