import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchUserscriptSource } from "../src/main/userscripts/userscriptUrlInstall.js";
import type { RemoteFetchImpl, RemoteLookupImpl } from "../src/main/remoteFetchGuard.js";

/**
 * P4 URL 安装的段 1（docs/specs/iab-userscripts.md P4 验收场景 7-9）：
 * 注入假 fetch/lookup，不触网。SSRF 守卫语义（协议白名单、私网拒绝、
 * 重定向逐跳校验、边读边计数、超时）在 remoteFetchGuard 内实现，
 * 这里验证 userscriptUrlInstall 的参数选择（https-only/20MB/20s/5 跳）、
 * guard 错误码到契约错误码的映射，以及 preview 与安装后扫描同源。
 */

const PUBLIC_A = { address: "93.184.216.34", family: 4 };
const PRIVATE_A = { address: "10.0.0.1", family: 4 };
const LOOPBACK_A = { address: "127.0.0.1", family: 4 };

function publicLookup(): RemoteLookupImpl {
  return (async () => [PUBLIC_A]) as unknown as RemoteLookupImpl;
}

function lookupReturning(
  ...addresses: Array<{ address: string; family: number }>
): RemoteLookupImpl {
  return (async () => addresses) as unknown as RemoteLookupImpl;
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

interface FakeResponseInit {
  status?: number;
  headers?: Record<string, string>;
  chunks?: Uint8Array[];
}

/**
 * 假 fetch：只实现 guard 用到的结构（status/ok/headers/body）。
 * 记录每次请求的 URL 顺序供重定向断言；dispatcher 忽略（真实 Agent 由 guard
 * 创建但从不真正连接，测试内 close 无副作用）。
 */
function fakeFetch(responder: (url: URL, call: number) => FakeResponseInit): {
  impl: RemoteFetchImpl;
  requested: URL[];
} {
  const requested: URL[] = [];
  const impl = (async (input: URL | string) => {
    const url = input instanceof URL ? input : new URL(String(input));
    requested.push(url);
    const init = responder(url, requested.length - 1);
    const status = init.status ?? 200;
    const response = new Response(init.chunks ? streamOf(init.chunks) : null, {
      status,
      headers: init.headers,
    });
    return response;
  }) as unknown as RemoteFetchImpl;
  return { impl, requested };
}

const GOOD_SCRIPT = [
  "// ==UserScript==",
  "// @name Installer",
  "// @version 1.2.3",
  "// @match https://installed.test/*",
  "// @grant GM_addStyle",
  "// @grant GM_getValue",
  "// ==/UserScript==",
  "void 0;",
  "",
].join("\n");

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("userscriptUrlInstall.fetchUserscriptSource", () => {
  it("正常 https：返回最终地址 + 源码 + 预览（name/version/runAt/grants/match），不落盘", async () => {
    const { impl } = fakeFetch(() => ({ chunks: [text(GOOD_SCRIPT)] }));
    const result = await fetchUserscriptSource("https://cdn.test/scripts/installed.user.js", {
      fetchImpl: impl,
      lookupImpl: publicLookup(),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.source.url, "https://cdn.test/scripts/installed.user.js");
    assert.equal(result.source.content, GOOD_SCRIPT);
    assert.deepEqual(result.preview, {
      name: "Installer",
      version: "1.2.3",
      runAt: "document-start",
      grants: ["GM_addStyle", "GM_getValue"],
      match: ["https://installed.test/*"],
    });
  });

  it("http:// 拒绝（not_https）；非法 URL 拒绝（invalid_url）", async () => {
    const { impl } = fakeFetch(() => ({ chunks: [text(GOOD_SCRIPT)] }));
    assert.deepEqual(
      await fetchUserscriptSource("http://cdn.test/x.user.js", { fetchImpl: impl }),
      {
        ok: false,
        error: "not_https",
      },
    );
    assert.deepEqual(await fetchUserscriptSource("not a url", { fetchImpl: impl }), {
      ok: false,
      error: "invalid_url",
    });
  });

  it("私网 / 环回解析拒绝（remote_address_not_allowed）", async () => {
    const { impl } = fakeFetch(() => ({ chunks: [text(GOOD_SCRIPT)] }));
    for (const lookup of [lookupReturning(PRIVATE_A), lookupReturning(LOOPBACK_A)]) {
      const result = await fetchUserscriptSource("https://rebind.test/x.user.js", {
        fetchImpl: impl,
        lookupImpl: lookup,
      });
      assert.deepEqual(result, { ok: false, error: "remote_address_not_allowed" });
    }
    // 数字 IP 字面量（10.0.0.1）同样经 lookup 校验被拒。
    assert.deepEqual(
      await fetchUserscriptSource("https://10.0.0.1/x.user.js", { fetchImpl: impl }),
      { ok: false, error: "remote_address_not_allowed" },
    );
  });

  it("fake-ip 环境放行：解析落 198.18.0.0/15 + DoH 复核真实公网 IP → 拉取成功（R2 候选 A）", async () => {
    // mihomo fake-ip 下 update.greasyfork.org → 198.18.x.x（TUN 虚拟映射）；
    // R2 起放行必须经 DoH 独立复核证明真实 IP 是公网。
    const { impl } = fakeFetch(() => ({ chunks: [text(GOOD_SCRIPT)] }));
    const dohQueries: string[] = [];
    const result = await fetchUserscriptSource("https://update.greasyfork.org/x.user.js", {
      fetchImpl: impl,
      lookupImpl: lookupReturning({ address: "198.18.1.50", family: 4 }),
      dohJsonImpl: async (url) => {
        dohQueries.push(url);
        return {
          Status: 0,
          Answer: [{ type: 1, data: "104.18.32.7" }],
        };
      },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.source.content, GOOD_SCRIPT);
    assert.equal(result.preview.name, "Installer");
    // A 与 AAAA 并发查询，均走 DoH JSON API。
    assert.equal(dohQueries.length, 2);
    assert.ok(dohQueries.every((q) => q.includes("name=update.greasyfork.org")));
  });

  it("fake-ip 段与黑名单段混合解析仍整体拒绝（some 语义不削弱，不触发 DoH）", async () => {
    const { impl } = fakeFetch(() => ({ chunks: [text(GOOD_SCRIPT)] }));
    let dohCalled = false;
    const result = await fetchUserscriptSource("https://mixed.test/x.user.js", {
      fetchImpl: impl,
      lookupImpl: lookupReturning({ address: "198.18.1.50", family: 4 }, LOOPBACK_A),
      dohJsonImpl: async () => {
        dohCalled = true;
        return { Status: 0, Answer: [] };
      },
    });
    assert.deepEqual(result, { ok: false, error: "remote_address_not_allowed" });
    assert.equal(dohCalled, false);
  });

  it("fake-ip 解析 + DoH 复核返回回环 → 闸门层拒绝（mint 负向：127-0-0-1.sslip.io）", async () => {
    const { impl } = fakeFetch(() => ({ chunks: [text(GOOD_SCRIPT)] }));
    const result = await fetchUserscriptSource("https://127-0-0-1.sslip.io:8444/x.user.js", {
      fetchImpl: impl,
      lookupImpl: lookupReturning({ address: "198.18.1.50", family: 4 }),
      dohJsonImpl: async () => ({ Status: 0, Answer: [{ type: 1, data: "127.0.0.1" }] }),
    });
    assert.deepEqual(result, { ok: false, error: "remote_address_not_allowed" });
  });

  it("fake-ip 解析 + DoH 复核返回内网 → 闸门层拒绝（mint 负向：192-168-5-15.sslip.io）", async () => {
    const { impl } = fakeFetch(() => ({ chunks: [text(GOOD_SCRIPT)] }));
    const result = await fetchUserscriptSource("https://192-168-5-15.sslip.io:8553/x.user.js", {
      fetchImpl: impl,
      lookupImpl: lookupReturning({ address: "198.18.1.50", family: 4 }),
      dohJsonImpl: async () => ({ Status: 0, Answer: [{ type: 1, data: "192.168.5.15" }] }),
    });
    assert.deepEqual(result, { ok: false, error: "remote_address_not_allowed" });
  });

  it("fake-ip 解析 + DoH 复核失败/超时/NXDOMAIN → fail-closed 拒绝", async () => {
    const { impl } = fakeFetch(() => ({ chunks: [text(GOOD_SCRIPT)] }));
    const fakeIp = lookupReturning({ address: "198.18.1.50", family: 4 });
    // DoH 网络失败。
    const networkFailure = await fetchUserscriptSource("https://a.test/x.user.js", {
      fetchImpl: impl,
      lookupImpl: fakeIp,
      dohJsonImpl: async () => {
        throw new Error("DoH unreachable");
      },
    });
    assert.deepEqual(networkFailure, { ok: false, error: "remote_address_not_allowed" });
    // DoH NXDOMAIN（Status=3）。
    const nxdomain = await fetchUserscriptSource("https://b.test/x.user.js", {
      fetchImpl: impl,
      lookupImpl: fakeIp,
      dohJsonImpl: async () => ({ Status: 3 }),
    });
    assert.deepEqual(nxdomain, { ok: false, error: "remote_address_not_allowed" });
    // NOERROR 但无 Answer（无 A/AAAA 记录）。
    const noAnswer = await fetchUserscriptSource("https://c.test/x.user.js", {
      fetchImpl: impl,
      lookupImpl: fakeIp,
      dohJsonImpl: async () => ({ Status: 0 }),
    });
    assert.deepEqual(noAnswer, { ok: false, error: "remote_address_not_allowed" });
  });

  it("fake-ip 解析 + DoH 返回多记录混合（公网 + 私网）→ some 语义拒绝", async () => {
    const { impl } = fakeFetch(() => ({ chunks: [text(GOOD_SCRIPT)] }));
    const result = await fetchUserscriptSource("https://multi.test/x.user.js", {
      fetchImpl: impl,
      lookupImpl: lookupReturning({ address: "198.18.1.50", family: 4 }),
      dohJsonImpl: async () => ({
        Status: 0,
        Answer: [
          { type: 1, data: "104.18.32.7" },
          { type: 1, data: "10.0.0.8" },
        ],
      }),
    });
    assert.deepEqual(result, { ok: false, error: "remote_address_not_allowed" });
  });

  it("非 fake-ip 公网解析不触发 DoH（普通环境零新依赖）", async () => {
    const { impl } = fakeFetch(() => ({ chunks: [text(GOOD_SCRIPT)] }));
    let dohCalled = false;
    const result = await fetchUserscriptSource("https://cdn.test/scripts/installed.user.js", {
      fetchImpl: impl,
      lookupImpl: publicLookup(),
      dohJsonImpl: async () => {
        dohCalled = true;
        return { Status: 0, Answer: [] };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(dohCalled, false);
  });

  it("content-length 超限拒绝（too_large）；无 content-length 的 chunked 边读边计数同样拦截", async () => {
    const twentyOneMB = 21 * 1024 * 1024;
    const withLength = fakeFetch(() => ({
      headers: { "content-length": String(twentyOneMB) },
      chunks: [text("x")],
    }));
    assert.deepEqual(
      await fetchUserscriptSource("https://cdn.test/big.user.js", {
        fetchImpl: withLength.impl,
        lookupImpl: publicLookup(),
      }),
      { ok: false, error: "too_large" },
    );

    // 无 content-length：两块各 11MB，第一块放行、累计超限时 abort。
    const elevenMB = new Uint8Array(11 * 1024 * 1024).fill(120); // 'x'
    const chunked = fakeFetch(() => ({ chunks: [elevenMB, elevenMB] }));
    assert.deepEqual(
      await fetchUserscriptSource("https://cdn.test/chunked.user.js", {
        fetchImpl: chunked.impl,
        lookupImpl: publicLookup(),
      }),
      { ok: false, error: "too_large" },
    );
  });

  it("重定向到私网拒绝；重定向到 http 拒绝（not_https）；跳数超限拒绝（download_failed）", async () => {
    // 第 1 跳公网、第 2 跳私网：guard 对每跳重新解析并校验（逐跳重验）。
    const calls: string[] = [];
    const hopLookup = (async (host: string) => {
      calls.push(host);
      return calls.length === 1 ? [PUBLIC_A] : [PRIVATE_A];
    }) as unknown as RemoteLookupImpl;
    const toPrivate = fakeFetch(() => ({
      status: 302,
      headers: { location: "https://evil.test/x" },
    }));
    const privateRedirect = await fetchUserscriptSource("https://start.test/x.user.js", {
      fetchImpl: toPrivate.impl,
      lookupImpl: hopLookup,
    });
    assert.deepEqual(privateRedirect, { ok: false, error: "remote_address_not_allowed" });
    assert.deepEqual(calls, ["start.test", "evil.test"]);

    // https → http：guard 的 protocol_not_allowed 映射为 not_https。
    const toHttp = fakeFetch(() => ({
      status: 302,
      headers: { location: "http://cdn.test/x.user.js" },
    }));
    const httpRedirect = await fetchUserscriptSource("https://start.test/x.user.js", {
      fetchImpl: toHttp.impl,
      lookupImpl: publicLookup(),
    });
    assert.deepEqual(httpRedirect, { ok: false, error: "not_https" });

    // 6 连跳（>5 次重定向）→ download_failed。
    const alwaysRedirect = fakeFetch(() => ({
      status: 302,
      headers: { location: "https://hop.test/next" },
    }));
    const exceeded = await fetchUserscriptSource("https://start.test/x.user.js", {
      fetchImpl: alwaysRedirect.impl,
      lookupImpl: publicLookup(),
    });
    assert.deepEqual(exceeded, { ok: false, error: "download_failed" });
  });

  it("超时（signal abort）映射为 timeout；连接失败等未知错误映射为 download_failed", async () => {
    // 挂起的 fetch：仅在 signal abort 时 reject——guard 的超时计时器触发 abort，
    // 可验证超时路径（deps.timeoutMs 注入短超时，真实值固定 20s 不进测试）。
    const hanging = (async (
      _url: URL | string,
      init?: { signal?: AbortSignal },
    ): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as RemoteFetchImpl;
    const timedOut = await fetchUserscriptSource("https://slow.test/x.user.js", {
      fetchImpl: hanging,
      lookupImpl: publicLookup(),
      timeoutMs: 20,
    });
    assert.deepEqual(timedOut, { ok: false, error: "timeout" });

    // 非 abort 的未知错误（连接拒绝等）→ download_failed。
    const quickFail = (async () => {
      throw new Error("connection refused");
    }) as unknown as RemoteFetchImpl;
    assert.deepEqual(
      await fetchUserscriptSource("https://unreachable.test/x.user.js", {
        fetchImpl: quickFail,
        lookupImpl: publicLookup(),
      }),
      { ok: false, error: "download_failed" },
    );
  });

  it("重定向后 source.url 为最终地址；404 → download_failed；空 body → download_failed", async () => {
    const { impl } = fakeFetch((url, call) =>
      call === 0
        ? { status: 302, headers: { location: "https://final.test/real.user.js" } }
        : { chunks: [text(GOOD_SCRIPT)] },
    );
    const result = await fetchUserscriptSource("https://start.test/x.user.js", {
      fetchImpl: impl,
      lookupImpl: publicLookup(),
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.source.url, "https://final.test/real.user.js");

    const notFound = fakeFetch(() => ({ status: 404 }));
    assert.deepEqual(
      await fetchUserscriptSource("https://cdn.test/missing.user.js", {
        fetchImpl: notFound.impl,
        lookupImpl: publicLookup(),
      }),
      { ok: false, error: "download_failed" },
    );

    const empty = fakeFetch(() => ({ chunks: [] }));
    assert.deepEqual(
      await fetchUserscriptSource("https://cdn.test/empty.user.js", {
        fetchImpl: empty.impl,
        lookupImpl: publicLookup(),
      }),
      { ok: false, error: "download_failed" },
    );
  });

  it("白名单外 grant：preview.parseError 非空（段 2 阻断）；解析失败同样承载", async () => {
    const rejected = [
      "// ==UserScript==",
      "// @name Bad",
      "// @match https://bad.test/*",
      "// @grant GM_xmlhttpRequest",
      "// ==/UserScript==",
      "void 0;",
    ].join("\n");
    const { impl } = fakeFetch(() => ({ chunks: [text(rejected)] }));
    const result = await fetchUserscriptSource("https://cdn.test/bad.user.js", {
      fetchImpl: impl,
      lookupImpl: publicLookup(),
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.preview.parseError, "grant not allowed: GM_xmlhttpRequest");
      assert.equal(result.preview.name, "Bad");
    }

    // 无元数据块 → parseError 承载解析失败（统一信号）。
    const noHeader = fakeFetch(() => ({ chunks: [text("void 0;")] }));
    const parseFail = await fetchUserscriptSource("https://cdn.test/nohdr.user.js", {
      fetchImpl: noHeader.impl,
      lookupImpl: publicLookup(),
    });
    assert.equal(parseFail.ok, true);
    if (parseFail.ok) assert.equal(parseFail.preview.parseError, "metadata block missing");
  });
});
