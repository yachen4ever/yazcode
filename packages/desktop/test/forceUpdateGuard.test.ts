import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { describe, it } from "node:test";
import type { Locale } from "@zcode/shared";
import { maybeBlockStartupForForceUpdate } from "../src/main/forceUpdateGuard.js";

const locale: Locale = "zh-CN";
const logger = { info: () => {}, warn: () => {} };

describe("强更门禁 stub（审计版安全姿态的承重锚）", () => {
  it("无条件放行：注入的远端检查、强更回调与 onBlocked 一概不被调用", async () => {
    const forbidden = () => {
      throw new Error("强更守卫不应触发注入的远端检查或回调");
    };
    const result = await maybeBlockStartupForForceUpdate({
      locale,
      logger,
      fetchRemoteConfig: forbidden,
      requestAutoUpdate: forbidden,
      onBlocked: forbidden,
    });
    assert.deepEqual(result, { blocked: false });
  });

  it("调用期间零外联：fetch/http/https 无任何调用，注入依赖也被无视", async () => {
    const calls: string[] = [];
    const originals = {
      fetch: globalThis.fetch,
      httpRequest: http.request,
      httpGet: http.get,
      httpsRequest: https.request,
      httpsGet: https.get,
    };
    const recordNet = (name: string) => {
      calls.push(name);
      throw new Error(`强更守卫不应发起网络请求：${name}`);
    };
    globalThis.fetch = (async () => recordNet("fetch")) as unknown as typeof fetch;
    http.request = (() => recordNet("http.request")) as unknown as typeof http.request;
    http.get = (() => recordNet("http.get")) as unknown as typeof http.get;
    https.request = (() => recordNet("https.request")) as unknown as typeof https.request;
    https.get = (() => recordNet("https.get")) as unknown as typeof https.get;
    try {
      const result = await maybeBlockStartupForForceUpdate({
        locale,
        logger,
        // 注入方即便给了真实现，stub 也必须无视：一旦被调用就进 calls，收尾断言抓包。
        fetchRemoteConfig: async () => {
          calls.push("fetchRemoteConfig");
          return {};
        },
        requestAutoUpdate: () => {
          calls.push("requestAutoUpdate");
        },
        onBlocked: () => {
          calls.push("onBlocked");
        },
      });
      assert.deepEqual(result, { blocked: false });
    } finally {
      globalThis.fetch = originals.fetch;
      http.request = originals.httpRequest;
      http.get = originals.httpGet;
      https.request = originals.httpsRequest;
      https.get = originals.httpsGet;
    }
    assert.deepEqual(calls, []);
  });
});
