import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createUserscriptFiles } from "../src/main/userscripts/userscriptFiles.js";
import { createUserscriptStorage } from "../src/main/userscripts/userscriptStorage.js";
import { isValidUserScriptId } from "../src/main/userscripts/userscriptRules.js";

/**
 * P4 写盘通道（docs/specs/iab-userscripts.md P4 验收场景 4-6、行为规则 3）：
 * - 新建 + 读回 + sha256 一致；重名显式覆盖（exists / overwrite:true + .bak 单代）；
 * - scriptId 校验矩阵（路径穿越 / Windows 非法字符 / 长度 / 空串）全拒且不产生文件；
 * - 大小上限写前拒绝（不留半写文件）；删除通道真假两分支；.bak 刻意保留。
 */

function makeFiles(scriptsDir: string, storageRootDir: string) {
  const storage = createUserscriptStorage({
    rootDir: storageRootDir,
    logger: { warn: () => {} },
  });
  const warnings: string[] = [];
  const files = createUserscriptFiles({
    scriptsDir,
    storage,
    logger: { info: () => {}, warn: (...args: unknown[]) => warnings.push(args.join(" ")) },
  });
  return { files, warnings };
}

const scriptBody = (match: string) =>
  `// ==UserScript==\n// @name files\n// @match ${match}\n// ==/UserScript==\nvoid 0;\n`;

async function assertNotExists(path: string): Promise<void> {
  await assert.rejects(stat(path), () => true);
}

describe("userscriptFiles.writeScript / readScript", () => {
  let root: string;
  let scriptsDir: string;
  let storageRootDir: string;
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "yazcode-userscript-files-"));
    scriptsDir = join(root, "userscripts");
    storageRootDir = join(root, "storage");
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("新建成功：内容读回一致，返回 sha256 与文件一致，目录自动创建", async () => {
    const { files } = makeFiles(scriptsDir, storageRootDir);
    const content = scriptBody("https://files.test/*");
    const write = await files.writeScript("hello", content, false);
    if (!write.ok) throw new Error(`write should succeed: ${JSON.stringify(write)}`);
    assert.equal(write.sha256.length, 64);

    const read = await files.readScript("hello");
    if (!read.ok) throw new Error(`read should succeed: ${JSON.stringify(read)}`);
    assert.equal(read.content, content);
    assert.equal(read.sha256, write.sha256);

    // scriptsDir 原本不存在：mkdir recursive 先行。
    assert.equal((await readdir(scriptsDir)).includes("hello.user.js"), true);
  });

  it("重名且 overwrite:false → exists，目标文件未被改动（P4 验收 4）", async () => {
    const { files } = makeFiles(scriptsDir, storageRootDir);
    const before = await readFile(join(scriptsDir, "hello.user.js"), "utf8");
    const rejected = await files.writeScript("hello", scriptBody("https://other.test/*"), false);
    assert.deepEqual(rejected, { ok: false, error: "exists" });
    assert.equal(await readFile(join(scriptsDir, "hello.user.js"), "utf8"), before);
  });

  it("overwrite:true 覆盖成功且生成单代 .bak；.bak 不进入 *.user.js 扫描口径", async () => {
    const { files } = makeFiles(scriptsDir, storageRootDir);
    const next = scriptBody("https://next.test/*");
    const write = await files.writeScript("hello", next, true);
    assert.equal(write.ok, true);

    const bak = await readFile(join(scriptsDir, "hello.user.js.bak"), "utf8");
    assert.equal(bak, scriptBody("https://files.test/*"));
    assert.equal(await readFile(join(scriptsDir, "hello.user.js"), "utf8"), next);

    // 再覆盖一次：.bak 单代（被替换为最近一次旧内容），不累积。
    const third = scriptBody("https://third.test/*");
    await files.writeScript("hello", third, true);
    assert.equal(await readFile(join(scriptsDir, "hello.user.js.bak"), "utf8"), next);

    // 只按 *.user.js 结尾过滤（store 扫描口径）看不到 .bak。
    const entries = (await readdir(scriptsDir)).filter((name) => name.endsWith(".user.js"));
    assert.deepEqual(entries, ["hello.user.js"]);
  });

  it("新文件（无覆盖）不产生 .bak", async () => {
    const { files } = makeFiles(scriptsDir, storageRootDir);
    await files.writeScript("fresh", scriptBody("https://fresh.test/*"), false);
    await assertNotExists(join(scriptsDir, "fresh.user.js.bak"));
  });

  it("scriptId 拒绝矩阵：全部 invalid_script_id 且不产生任何文件（P4 验收 5）", async () => {
    const { files } = makeFiles(scriptsDir, storageRootDir);
    const before = (await readdir(scriptsDir)).sort();
    for (const scriptId of [
      "../evil",
      "a/b",
      "a\\b",
      ".",
      "..",
      ".hidden",
      "name.",
      "con:",
      "x".repeat(65),
      "",
      "sp ",
      "a<b",
      'a"b',
      "a|b",
      "a?b",
      "a*b",
    ]) {
      const write = await files.writeScript(scriptId, scriptBody("https://x.test/*"), false);
      assert.deepEqual(
        write,
        { ok: false, error: "invalid_script_id" },
        `scriptId=${JSON.stringify(scriptId)}`,
      );
      const read = await files.readScript(scriptId);
      assert.deepEqual(
        read,
        { ok: false, error: "invalid_script_id" },
        `read ${JSON.stringify(scriptId)}`,
      );
    }
    assert.deepEqual((await readdir(scriptsDir)).sort(), before);
  });

  it("isValidUserScriptId 边界：my..script 合法（m2-6 不回归）；尾随空格与控制字符拒绝", () => {
    assert.equal(isValidUserScriptId("my..script"), true);
    assert.equal(isValidUserScriptId("a b"), true);
    assert.equal(isValidUserScriptId("名字"), true);
    assert.equal(isValidUserScriptId("x".repeat(64)), true);
    assert.equal(isValidUserScriptId("sp "), false);
    assert.equal(isValidUserScriptId("name."), false);
    assert.equal(isValidUserScriptId(".hidden"), false);
    assert.equal(isValidUserScriptId("a\x01b"), false);
    assert.equal(isValidUserScriptId("a\x7fb"), false);
  });

  it(">2MB 内容拒绝（too_large）且不写文件、不留半写文件（P4 验收 6）", async () => {
    const { files } = makeFiles(scriptsDir, storageRootDir);
    const big = "x".repeat(2 * 1024 * 1024 + 1);
    const rejected = await files.writeScript("big", big, false);
    assert.deepEqual(rejected, { ok: false, error: "too_large" });
    const entries = (await readdir(scriptsDir)).filter((name) => name.startsWith("big"));
    assert.deepEqual(entries, []);
  });

  it("空内容拒绝（invalid_content）", async () => {
    const { files } = makeFiles(scriptsDir, storageRootDir);
    assert.deepEqual(await files.writeScript("empty", "", false), {
      ok: false,
      error: "invalid_content",
    });
  });
});

describe("userscriptFiles.deleteScript", () => {
  let root: string;
  let scriptsDir: string;
  let storageRootDir: string;
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "yazcode-userscript-del-"));
    scriptsDir = join(root, "userscripts");
    storageRootDir = join(root, "storage");
    await mkdir(scriptsDir, { recursive: true });
    await mkdir(storageRootDir, { recursive: true });
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("deleteStorage:false 只删脚本文件，GM 存储保留（P4 验收 10 取消分支）", async () => {
    const { files } = makeFiles(scriptsDir, storageRootDir);
    await files.writeScript("keeper", scriptBody("https://keeper.test/*"), false);
    await writeFile(join(storageRootDir, "keeper.json"), JSON.stringify({ k: "v" }), "utf8");
    const result = await files.deleteScript("keeper", false);
    assert.deepEqual(result, { ok: true, deletedFile: true, deletedStorage: false });
    await assert.rejects(readFile(join(scriptsDir, "keeper.user.js"), "utf8"), () => true);
    assert.equal(
      await readFile(join(storageRootDir, "keeper.json"), "utf8"),
      JSON.stringify({ k: "v" }),
    );
  });

  it("deleteStorage:true 连带删除 GM 存储（P4 验收 10 确认分支）", async () => {
    const { files } = makeFiles(scriptsDir, storageRootDir);
    await files.writeScript("wiped", scriptBody("https://wiped.test/*"), false);
    await writeFile(join(storageRootDir, "wiped.json"), JSON.stringify({ k: "v" }), "utf8");
    const result = await files.deleteScript("wiped", true);
    assert.deepEqual(result, { ok: true, deletedFile: true, deletedStorage: true });
    await assert.rejects(readFile(join(storageRootDir, "wiped.json"), "utf8"), () => true);
  });

  it("文件不存在 → unknown_script；已删脚本的 .bak 保留（spec：用户可手工回收）", async () => {
    const { files } = makeFiles(scriptsDir, storageRootDir);
    await files.writeScript("bakkept", scriptBody("https://bak.test/*"), false);
    await files.writeScript("bakkept", scriptBody("https://bak2.test/*"), true);
    const result = await files.deleteScript("bakkept", false);
    assert.equal(result.ok, true);
    // .bak 不随删除消失。
    assert.equal(
      await readFile(join(scriptsDir, "bakkept.user.js.bak"), "utf8"),
      scriptBody("https://bak.test/*"),
    );
    const missing = await files.deleteScript("bakkept", true);
    assert.deepEqual(missing, { ok: false, error: "unknown_script" });
  });

  it("非法 scriptId 拒绝删除（invalid_script_id）", async () => {
    const { files } = makeFiles(scriptsDir, storageRootDir);
    assert.deepEqual(await files.deleteScript("../evil", true), {
      ok: false,
      error: "invalid_script_id",
    });
  });
});
