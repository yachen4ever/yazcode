import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { parseStorageGetRequest, parseStorageSetRequest } from "../src/main/userscripts/userscriptIpcContract.js";
import { createUserscriptService, type UserscriptRequestContext } from "../src/main/userscripts/userscriptService.js";

const mainFrameContext: UserscriptRequestContext = { isMainFrame: true, isAllowedSender: true };
const subFrameContext: UserscriptRequestContext = { isMainFrame: false, isAllowedSender: true };
const foreignContext: UserscriptRequestContext = { isMainFrame: true, isAllowedSender: false };

function scriptWithGrant(match: string, grant?: string): string {
  return `// ==UserScript==\n// @name svc\n// @match ${match}\n${
    grant ? `// @grant ${grant}\n` : ""
  }// ==/UserScript==\nvoid 0;\n`;
}

async function makeService(manifest: Record<string, { enabled: boolean; sha256?: string }>) {
  const root = await mkdtemp(join(tmpdir(), "yazcode-userscript-svc-"));
  const scriptsDir = join(root, "userscripts");
  const storageRootDir = join(root, "storage");
  await mkdir(scriptsDir, { recursive: true });
  await writeFile(join(scriptsDir, "svc.user.js"), scriptWithGrant("https://svc.test/*", "GM_getValue GM_setValue GM_deleteValue GM_listValues GM_addStyle"));
  await writeFile(join(scriptsDir, "sub.user.js"), scriptWithGrant("https://svc.test/sub*", "GM_addStyle"));
  await writeFile(join(scriptsDir, "rejected.user.js"), scriptWithGrant("https://svc.test/*", "GM_xmlhttpRequest"));
  const service = createUserscriptService({
    scriptsDir,
    storageRootDir,
    manifestPort: {
      async getManifest() {
        return manifest;
      },
      async saveManifest() {},
    },
    logger: { info: () => {}, warn: () => {} },
  });
  return { service, storageRootDir, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("userscriptService.match", () => {
  let ctx: Awaited<ReturnType<typeof makeService>>;
  before(async () => {
    ctx = await makeService({
      svc: { enabled: true },
      sub: { enabled: true },
      rejected: { enabled: true },
      disabled: { enabled: false },
    });
    // disabled 条目对应文件不存在不影响判定：无条目/未启用都不出现在服务集。
  });
  after(async () => {
    await ctx.cleanup();
  });

  it("只回 enabled 且校验通过的脚本，回包含 code 但不含文件路径", async () => {
    const response = await ctx.service.match({ url: "https://svc.test/page" }, mainFrameContext);
    // sub 的 @match 是 /sub*，不命中 /page。
    assert.deepEqual(
      response.scripts.map((item) => item.scriptId),
      ["svc"],
    );
    for (const item of response.scripts) {
      assert.equal(typeof item.code, "string");
      assert.ok(Object.keys(item).every((key) => key !== "path" && key !== "filePath"));
    }
  });

  it("@match 过滤生效；grant 拒载脚本不出现", async () => {
    const response = await ctx.service.match({ url: "https://svc.test/sub-page" }, mainFrameContext);
    assert.deepEqual(
      response.scripts.map((item) => item.scriptId).sort(),
      ["sub", "svc"],
    );
    assert.ok(!response.scripts.some((item) => item.scriptId === "rejected"));
  });

  it("非 IAB 分区请求 / 非法入参 / 非 http(s) URL 返回空集", async () => {
    assert.deepEqual(await ctx.service.match({ url: "https://svc.test/" }, foreignContext), {
      scripts: [],
    });
    assert.deepEqual(await ctx.service.match({ url: "chrome-error://x/" }, mainFrameContext), {
      scripts: [],
    });
    assert.deepEqual(await ctx.service.match("garbage", mainFrameContext), { scripts: [] });
  });
});

describe("userscriptService.get/set 守卫与存储", () => {
  let ctx: Awaited<ReturnType<typeof makeService>>;
  before(async () => {
    ctx = await makeService({ svc: { enabled: true } });
  });
  after(async () => {
    await ctx.cleanup();
  });

  it("set → get 回读一致；listValues 返回现存键；deleteValue 幂等", async () => {
    assert.equal(
      (await ctx.service.setStorage({ kind: "put", scriptId: "svc", key: "token", value: "abc" }, mainFrameContext)).ok,
      true,
    );
    const got = await ctx.service.getStorage({ kind: "get", scriptId: "svc", key: "token" }, mainFrameContext);
    assert.equal(got.ok, true);
    assert.equal(got.value, "abc");

    const list = await ctx.service.getStorage({ kind: "list", scriptId: "svc" }, mainFrameContext);
    assert.deepEqual(list.keys, ["token"]);

    assert.equal(
      (await ctx.service.setStorage({ kind: "delete", scriptId: "svc", key: "token" }, mainFrameContext)).ok,
      true,
    );
    const gone = await ctx.service.getStorage({ kind: "get", scriptId: "svc", key: "token" }, mainFrameContext);
    assert.equal(got.ok, true);
    assert.equal("value" in gone, false);

    // key 缺失时 delete 也成功（幂等）。
    assert.equal(
      (await ctx.service.setStorage({ kind: "delete", scriptId: "svc", key: "token" }, mainFrameContext)).ok,
      true,
    );
  });

  it("get 缺 key 返回 ok 且不带 value（调用方取默认值语义）", async () => {
    const result = await ctx.service.getStorage({ kind: "get", scriptId: "svc", key: "missing" }, mainFrameContext);
    assert.equal(result.ok, true);
    assert.equal("value" in result, false);
  });

  it("子 frame 存储请求被拒（sub_frame_denied）", async () => {
    const denied = await ctx.service.getStorage(
      { kind: "get", scriptId: "svc", key: "token" },
      subFrameContext,
    );
    assert.equal(denied.ok, false);
    assert.equal(denied.error, "sub_frame_denied");
    const deniedSet = await ctx.service.setStorage(
      { kind: "put", scriptId: "svc", key: "k", value: 1 },
      subFrameContext,
    );
    assert.equal(deniedSet.error, "sub_frame_denied");
  });

  it("非 IAB 分区请求被拒（invalid_request）", async () => {
    const result = await ctx.service.getStorage(
      { kind: "get", scriptId: "svc", key: "token" },
      foreignContext,
    );
    assert.equal(result.error, "invalid_request");
  });

  it("非法形状/超长 key/不可序列化 value/未知 scriptId 按错误码拒绝", async () => {
    assert.equal(
      (await ctx.service.setStorage("garbage", mainFrameContext)).error,
      "invalid_request",
    );
    // 超长 key：契约层形状放行（非空字符串），服务层 key 上限校验拒掉。
    const longKey = "k".repeat(513);
    assert.ok(parseStorageSetRequest({ kind: "put", scriptId: "svc", key: longKey, value: 1 }));
    assert.equal(
      (await ctx.service.setStorage({ kind: "put", scriptId: "svc", key: longKey, value: 1 }, mainFrameContext)).error,
      "invalid_key",
    );
    assert.equal(
      (await ctx.service.getStorage({ kind: "get", scriptId: "svc", key: longKey }, mainFrameContext)).error,
      "invalid_key",
    );
    assert.ok(parseStorageGetRequest({ kind: "get", scriptId: "svc", key: "" }) === null);
    assert.equal(
      (await ctx.service.setStorage({ kind: "put", scriptId: "svc", key: "k", value: undefined }, mainFrameContext))
        .error,
      "invalid_request",
    );
    assert.equal(
      (await ctx.service.setStorage({ kind: "put", scriptId: "svc", key: "k", value: () => 1 }, mainFrameContext))
        .error,
      "invalid_request",
    );
    assert.equal(
      (await ctx.service.getStorage({ kind: "get", scriptId: "nope", key: "k" }, mainFrameContext)).error,
      "unknown_script",
    );
  });

  it("grant 拒载的脚本即使 enabled 也不可访问存储（unknown_script）", async () => {
    const other = await makeService({ rejected: { enabled: true } });
    try {
      const result = await other.service.getStorage(
        { kind: "get", scriptId: "rejected", key: "k" },
        mainFrameContext,
      );
      assert.equal(result.error, "unknown_script");
    } finally {
      await other.cleanup();
    }
  });

  it("并发 set 按 scriptId 串行化，两个更新都落盘", async () => {
    const results = await Promise.all([
      ctx.service.setStorage({ kind: "put", scriptId: "svc", key: "a", value: 1 }, mainFrameContext),
      ctx.service.setStorage({ kind: "put", scriptId: "svc", key: "b", value: 2 }, mainFrameContext),
    ]);
    assert.ok(results.every((result) => result.ok));
    const list = await ctx.service.getStorage({ kind: "list", scriptId: "svc" }, mainFrameContext);
    assert.deepEqual([...(list.keys ?? [])].sort(), ["a", "b"]);
  });

  it("单脚本存储超 2MB 拒绝（storage_limit），原内容不受影响", async () => {
    assert.equal(
      (await ctx.service.setStorage({ kind: "put", scriptId: "svc", key: "a", value: "x" }, mainFrameContext)).ok,
      true,
    );
    const oversized = "y".repeat(3 * 1024 * 1024);
    const rejected = await ctx.service.setStorage(
      { kind: "put", scriptId: "svc", key: "big", value: oversized },
      mainFrameContext,
    );
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error, "storage_limit");
    const list = await ctx.service.getStorage({ kind: "list", scriptId: "svc" }, mainFrameContext);
    assert.deepEqual([...(list.keys ?? [])].sort(), ["a", "b"]);
  });

  it("存储落盘为按 scriptId 命名空间的 JSON 文件", async () => {
    await ctx.service.setStorage({ kind: "put", scriptId: "svc", key: "json", value: { nested: [1, 2] } }, mainFrameContext);
    const raw = JSON.parse(await readFile(join(ctx.storageRootDir, "svc.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(raw.json, { nested: [1, 2] });
  });
});
