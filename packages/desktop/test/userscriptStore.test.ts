import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  computeScriptSha256,
  createUserscriptStore,
  type UserscriptManifestPort,
} from "../src/main/userscripts/userscriptStore.js";

/** manifest 端口假实现：内存态 + 捕获保存调用（锚定写验证用）。 */
function fakeManifestPort(initial: Record<string, { enabled: boolean; sha256?: string }> = {}) {
  const saved: Array<Record<string, { enabled: boolean; sha256?: string }>> = [];
  let current = initial;
  return {
    port: {
      async getManifest() {
        return current;
      },
      async saveManifest(manifest) {
        saved.push(manifest);
        current = manifest;
      },
    } satisfies UserscriptManifestPort,
    saved,
  };
}

const scriptBody = (match: string, extra = "") =>
  `// ==UserScript==\n// @name test\n// @match ${match}\n${extra}// ==/UserScript==\nvoid 0;\n`;

describe("createUserscriptStore.scan", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "yazcode-userscripts-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("目录不存在按空服务集处理（功能未使用不是错误）", async () => {
    const store = createUserscriptStore({
      scriptsDir: join(dir, "missing"),
      manifestPort: fakeManifestPort().port,
      logger: { info: () => {}, warn: () => {} },
    });
    const result = await store.scan();
    assert.deepEqual(result.serveable, []);
    assert.deepEqual(result.findings, []);
  });

  it("只扫一层 *.user.js：子目录与其它扩展名忽略；新文件无条目不服务（发现≠启用）", async () => {
    const scriptsDir = join(dir, "scan");
    await mkdir(scriptsDir, { recursive: true });
    await writeFile(join(scriptsDir, "a.user.js"), scriptBody("https://a.test/*"));
    await writeFile(join(scriptsDir, "b.txt"), "not a script");
    await mkdir(join(scriptsDir, "nested"));
    await writeFile(join(scriptsDir, "nested", "c.user.js"), scriptBody("https://c.test/*"));

    const store = createUserscriptStore({
      scriptsDir,
      manifestPort: fakeManifestPort().port,
      logger: { info: () => {}, warn: () => {} },
    });
    const result = await store.scan();
    assert.deepEqual(result.serveable, []);
    assert.deepEqual(
      result.findings.map((finding) => finding.scriptId),
      ["a"],
    );
    assert.equal(result.findings[0]?.status, "disabled");
  });

  it("enabled 无 sha256 → 扫描时锚定（manifest 写回当前 hash）并开始服务", async () => {
    const scriptsDir = join(dir, "anchor");
    await mkdir(scriptsDir, { recursive: true });
    const code = scriptBody("https://a.test/*", "// @grant GM_addStyle\n");
    await writeFile(join(scriptsDir, "a.user.js"), code);
    const { port, saved } = fakeManifestPort({ a: { enabled: true } });

    const store = createUserscriptStore({
      scriptsDir,
      manifestPort: port,
      logger: { info: () => {}, warn: () => {} },
    });
    const first = await store.scan();
    assert.equal(first.serveable.length, 1);
    assert.equal(first.findings[0]?.status, "anchored");
    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.a?.sha256, computeScriptSha256(Buffer.from(code)));
    assert.equal(saved[0]?.a?.enabled, true);

    // 第二次扫描：已锚定不再重写，hash 一致继续服务。
    const second = await store.scan();
    assert.equal(saved.length, 1);
    assert.equal(second.serveable.length, 1);
    assert.ok(!second.findings.some((finding) => finding.status === "anchored"));
  });

  it("锚定后内容变更 → hash 不一致停止服务（fail-closed）；重新批准后恢复", async () => {
    const scriptsDir = join(dir, "mismatch");
    await mkdir(scriptsDir, { recursive: true });
    const file = join(scriptsDir, "m.user.js");
    await writeFile(file, scriptBody("https://m.test/*"));
    const { port, saved } = fakeManifestPort({ m: { enabled: true } });
    const store = createUserscriptStore({
      scriptsDir,
      manifestPort: port,
      logger: { info: () => {}, warn: () => {} },
    });
    assert.equal((await store.scan()).serveable.length, 1);

    await writeFile(file, scriptBody("https://m.test/*", "// @version 2\n"));
    const afterChange = await store.scan();
    assert.deepEqual(afterChange.serveable, []);
    assert.equal(afterChange.findings[0]?.status, "hash_mismatch");

    // 重新批准 = 条目回到 enabled 无 sha（P2 确认流之前的手工路径）。
    await port.saveManifest({ m: { enabled: true } });
    assert.equal(saved.length, 2);
    const reApproved = await store.scan();
    assert.equal(reApproved.serveable.length, 1);
  });

  it("grant fail-closed：白名单外 grant 整只拒载并记录", async () => {
    const scriptsDir = join(dir, "grant");
    await mkdir(scriptsDir, { recursive: true });
    await writeFile(
      join(scriptsDir, "g.user.js"),
      scriptBody("https://g.test/*", "// @grant GM_xmlhttpRequest\n"),
    );
    const store = createUserscriptStore({
      scriptsDir,
      manifestPort: fakeManifestPort({ g: { enabled: true } }).port,
      logger: { info: () => {}, warn: () => {} },
    });
    const result = await store.scan();
    assert.deepEqual(result.serveable, []);
    assert.equal(result.findings[0]?.status, "grant_rejected");
  });

  it("解析失败（无块/缺 @match/非法 pattern）拒载并记录原因", async () => {
    const scriptsDir = join(dir, "parse");
    await mkdir(scriptsDir, { recursive: true });
    await writeFile(join(scriptsDir, "noblock.user.js"), "const x = 1;");
    await writeFile(join(scriptsDir, "nomatch.user.js"), "// ==UserScript==\n// @name x\n// ==/UserScript==");
    await writeFile(
      join(scriptsDir, "badpattern.user.js"),
      scriptBody("http://bad.test"),
    );
    const store = createUserscriptStore({
      scriptsDir,
      manifestPort: fakeManifestPort({
        noblock: { enabled: true },
        nomatch: { enabled: true },
        badpattern: { enabled: true },
      }).port,
      logger: { info: () => {}, warn: () => {} },
    });
    const result = await store.scan();
    assert.deepEqual(result.serveable, []);
    for (const finding of result.findings) {
      assert.equal(finding.status, "parse_failed", finding.scriptId);
    }
  });
});
