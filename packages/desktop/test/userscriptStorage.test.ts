import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  createUserscriptStorage,
  USER_SCRIPT_STORAGE_MAX_BYTES,
} from "../src/main/userscripts/userscriptStorage.js";

/**
 * GM 存储单元测试（复核 m2-5 / m2-6 行为锚点）：
 * - 损坏存储文件显式失败（storage_corrupt）且原样保留、不覆盖；
 * - scriptId 按路径段判定：含 ".." 子串的合法名不再误拒，dot 段与分隔符仍拒绝。
 */

async function makeStorage() {
  const root = await mkdtemp(join(tmpdir(), "yazcode-userscript-storage-"));
  const rootDir = join(root, "storage");
  await mkdir(rootDir, { recursive: true });
  const warnings: string[] = [];
  const storage = createUserscriptStorage({
    rootDir,
    logger: { warn: (...args: unknown[]) => warnings.push(args.join(" ")) },
  });
  return {
    storage,
    rootDir,
    warnings,
    filePath: (scriptId: string) => join(rootDir, `${scriptId}.json`),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

describe("userscriptStorage.scriptId 判定（m2-6）", () => {
  let ctx: Awaited<ReturnType<typeof makeStorage>>;
  before(async () => {
    ctx = await makeStorage();
  });
  after(async () => {
    await ctx.cleanup();
  });

  it("含 .. 子串的合法 scriptId 不再误拒：set/get 正常落盘", async () => {
    const setResult = await ctx.storage.setValue("my..script", "k", 1);
    assert.deepEqual(setResult, { ok: true });
    assert.equal(await ctx.storage.hasStorageFile("my..script"), true);
    const getResult = await ctx.storage.getValue("my..script", "k");
    assert.deepEqual(getResult, { ok: true, value: 1 });
  });

  it("dot 段与路径分隔符仍拒绝（路径穿越挡住）", async () => {
    for (const scriptId of ["..", ".", "a/b", "a\\b"]) {
      const result = await ctx.storage.getValue(scriptId, "k");
      assert.deepEqual(result, { ok: false, error: "storage_error" }, `scriptId=${scriptId}`);
      assert.equal(await ctx.storage.hasStorageFile(scriptId), false);
    }
  });
});

describe("userscriptStorage.损坏文件显式失败（m2-5）", () => {
  let ctx: Awaited<ReturnType<typeof makeStorage>>;
  const corruptScriptId = "corrupt";
  const corruptBytes = "{ not valid json !!";
  before(async () => {
    ctx = await makeStorage();
    await writeFile(join(ctx.rootDir, `${corruptScriptId}.json`), corruptBytes, "utf8");
  });
  after(async () => {
    await ctx.cleanup();
  });

  it("四个存储操作对损坏文件统一回 storage_corrupt", async () => {
    assert.deepEqual(await ctx.storage.getValue(corruptScriptId, "k"), {
      ok: false,
      error: "storage_corrupt",
    });
    assert.deepEqual(await ctx.storage.listValues(corruptScriptId), {
      ok: false,
      error: "storage_corrupt",
    });
    assert.deepEqual(await ctx.storage.setValue(corruptScriptId, "k", 1), {
      ok: false,
      error: "storage_corrupt",
    });
    assert.deepEqual(await ctx.storage.deleteValue(corruptScriptId, "k"), {
      ok: false,
      error: "storage_corrupt",
    });
  });

  it("损坏文件原样保留、不覆盖（不自动清数据）", async () => {
    assert.equal(await readFile(ctx.filePath(corruptScriptId), "utf8"), corruptBytes);
  });

  it("损坏文件记录 warn（观测面可见）", () => {
    assert.ok(
      ctx.warnings.some((line) => line.includes(corruptScriptId) && line.includes("corrupt")),
      `warnings=${JSON.stringify(ctx.warnings)}`,
    );
  });

  it("用户修复文件后存储恢复可用", async () => {
    await writeFile(ctx.filePath(corruptScriptId), JSON.stringify({ k: "repaired" }), "utf8");
    assert.deepEqual(await ctx.storage.getValue(corruptScriptId, "k"), {
      ok: true,
      value: "repaired",
    });
  });

  it("顶层形状非法（数组/标量/null）同样判损坏", async () => {
    for (const [name, content] of [
      ["array", "[1,2]"],
      ["scalar", "42"],
      ["null", "null"],
    ] as const) {
      await writeFile(ctx.filePath(name), content, "utf8");
      assert.deepEqual(
        await ctx.storage.getValue(name, "k"),
        { ok: false, error: "storage_corrupt" },
        `content=${content}`,
      );
    }
  });
});

describe("userscriptStorage 常规行为（回归锚点）", () => {
  let ctx: Awaited<ReturnType<typeof makeStorage>>;
  before(async () => {
    ctx = await makeStorage();
  });
  after(async () => {
    await ctx.cleanup();
  });

  it("set → get 回读一致；delete 清空后移除文件", async () => {
    assert.deepEqual(await ctx.storage.setValue("plain", "a", { nested: true }), { ok: true });
    assert.deepEqual(await ctx.storage.getValue("plain", "a"), {
      ok: true,
      value: { nested: true },
    });
    assert.deepEqual(await ctx.storage.listValues("plain"), { ok: true, keys: ["a"] });
    assert.deepEqual(await ctx.storage.deleteValue("plain", "a"), { ok: true });
    assert.equal(await ctx.storage.hasStorageFile("plain"), false);
    // key 缺失：ok 且不带 value（调用方取默认值）。
    assert.deepEqual(await ctx.storage.getValue("plain", "missing"), { ok: true });
  });

  it("并发 set 串行化不丢更新", async () => {
    await Promise.all([
      ctx.storage.setValue("concurrent", "x", 1),
      ctx.storage.setValue("concurrent", "y", 2),
      ctx.storage.setValue("concurrent", "z", 3),
    ]);
    const keys = await ctx.storage.listValues("concurrent");
    assert.deepEqual(keys, { ok: true, keys: ["x", "y", "z"] });
  });

  it("单脚本存储超 2MB 拒绝（storage_limit），原文件不动", async () => {
    await ctx.storage.setValue("limit", "keep", "v");
    const before = await readFile(ctx.filePath("limit"), "utf8");
    const bigValue = "x".repeat(USER_SCRIPT_STORAGE_MAX_BYTES);
    assert.deepEqual(await ctx.storage.setValue("limit", "big", bigValue), {
      ok: false,
      error: "storage_limit",
    });
    assert.equal(await readFile(ctx.filePath("limit"), "utf8"), before);
  });
});
