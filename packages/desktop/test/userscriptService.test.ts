import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { parseStorageGetRequest, parseStorageSetRequest } from "../src/main/userscripts/userscriptIpcContract.js";
import { createUserscriptService, type UserscriptRequestContext } from "../src/main/userscripts/userscriptService.js";
import { createUserscriptFiles } from "../src/main/userscripts/userscriptFiles.js";
import { createUserscriptStorage } from "../src/main/userscripts/userscriptStorage.js";
import type { UserscriptManifestPort } from "../src/main/userscripts/userscriptStore.js";

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
  return {
    service,
    storageRootDir,
    scriptsDir,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
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

/**
 * P3 注入时刻（docs/specs/iab-userscripts.md P3 验收场景 1-3）：
 * match 对实际回包的脚本逐条记录，listStatus/statusOverview 合并；未命中缺席；
 * 两次 match 覆盖取较新；新建实例清零；删除脚本后内存表裁剪。
 */
describe("userscriptService.lastInjectedAt", () => {
  async function makeInjectionService() {
    const ctx = await makeService({
      svc: { enabled: true },
      sub: { enabled: true },
    });
    // 首扫锚定（P1 语义），否则状态停留在 enabled_pending_anchor。
    await ctx.service.reload();
    return ctx;
  }

  it("match 后 listStatus/statusOverview 带出 lastInjectedAt；未命中脚本字段缺席", async () => {
    const ctx = await makeInjectionService();
    try {
      const before = Date.now();
      await ctx.service.match({ url: "https://svc.test/page" }, mainFrameContext);
      const after = Date.now();

      const statuses = await ctx.service.listStatus();
      const svc = statuses.find((item) => item.scriptId === "svc");
      assert.ok(svc?.lastInjectedAt !== undefined);
      assert.ok(svc.lastInjectedAt >= before && svc.lastInjectedAt <= after);
      // sub 的 @match 是 /sub*，本 URL 未命中 → 字段缺席（不是 null/0）。
      const sub = statuses.find((item) => item.scriptId === "sub");
      assert.equal(sub !== undefined && "lastInjectedAt" in sub, false);

      const overview = await ctx.service.statusOverview();
      assert.equal(
        overview.find((item) => item.scriptId === "svc")?.lastInjectedAt,
        svc.lastInjectedAt,
      );
      assert.equal(
        overview.some((item) => item.scriptId === "sub" && "lastInjectedAt" in item),
        false,
      );
    } finally {
      await ctx.cleanup();
    }
  });

  it("两次 match 取较新值（覆盖而非累加）", async () => {
    const ctx = await makeInjectionService();
    try {
      await ctx.service.match({ url: "https://svc.test/page" }, mainFrameContext);
      const first = (await ctx.service.listStatus()).find(
        (item) => item.scriptId === "svc",
      )?.lastInjectedAt;
      // 保证时钟前进（同毫秒内两次调用无法区分，sleep 覆盖 Date.now 精度）。
      await new Promise((resolve) => setTimeout(resolve, 2));
      await ctx.service.match({ url: "https://svc.test/page" }, mainFrameContext);
      const second = (await ctx.service.listStatus()).find(
        (item) => item.scriptId === "svc",
      )?.lastInjectedAt;
      assert.ok(first !== undefined && second !== undefined);
      assert.ok(second >= first);
    } finally {
      await ctx.cleanup();
    }
  });

  it("新建 service 实例（模拟进程重启）后 lastInjectedAt 全部缺席", async () => {
    const ctx = await makeInjectionService();
    try {
      await ctx.service.match({ url: "https://svc.test/page" }, mainFrameContext);
      assert.ok((await ctx.service.listStatus()).some((item) => "lastInjectedAt" in item));

      // 同目录、同 manifest 新建实例：内存表随进程清零。
      const restarted = createUserscriptService({
        scriptsDir: ctx.scriptsDir,
        storageRootDir: ctx.storageRootDir,
        manifestPort: {
          getManifest: async () => ({ svc: { enabled: true, sha256: "" } }),
          saveManifest: async () => {},
        },
        logger: { info: () => {}, warn: () => {} },
      });
      const statuses = await restarted.listStatus();
      assert.ok(statuses.every((item) => !("lastInjectedAt" in item)));
    } finally {
      await ctx.cleanup();
    }
  });

  it("删除脚本后 inspect 路径裁剪内存表条目", async () => {
    const ctx = await makeInjectionService();
    try {
      await ctx.service.match({ url: "https://svc.test/sub-page" }, mainFrameContext);
      const injected = (await ctx.service.listStatus()).filter((item) =>
        ["svc", "sub"].includes(item.scriptId),
      );
      assert.deepEqual(
        injected.map((item) => "lastInjectedAt" in item),
        [true, true],
      );

      // 删除后一次 inspect：扫描集合不含 svc，内存表条目被裁剪。
      await rm(join(ctx.scriptsDir, "svc.user.js"));
      assert.equal(
        (await ctx.service.listStatus()).some((item) => item.scriptId === "svc"),
        false,
      );

      // 同 scriptId 重新落盘：若内存表未裁剪，旧注入时刻会「复活」。
      await writeFile(join(ctx.scriptsDir, "svc.user.js"), scriptWithGrant("https://svc.test/*"));
      const revived = (await ctx.service.listStatus()).find((item) => item.scriptId === "svc");
      assert.ok(revived);
      assert.equal("lastInjectedAt" in revived, false);

      await rm(join(ctx.scriptsDir, "sub.user.js"));
      await rm(join(ctx.scriptsDir, "svc.user.js"));
      const remaining = await ctx.service.listStatus();
      // 剩余只有静态拒载行；内存表已空，任何行都不带注入时刻。
      assert.deepEqual(
        remaining.filter((item) => ["svc", "sub"].includes(item.scriptId)),
        [],
      );
      assert.ok(remaining.every((item) => !("lastInjectedAt" in item)));
    } finally {
      await ctx.cleanup();
    }
  });
});

/**
 * P4 落盘 ≠ 批准（docs/specs/iab-userscripts.md P4 验收场景 1/3）：
 * 写盘通道（userscriptFiles）与状态投影（service.listStatus）共享同一目录与
 * manifest 端口——写盘后 main 一概不 patch manifest：
 * - 新建：无条目 → 状态 disabled（服务集不含），UI patch pendingApproval 后才进待批准；
 * - 编辑已批准脚本：manifest 不变（仍 enabled + 旧 sha），扫描自然落 hash_mismatch。
 */
describe("userscriptService P4 落盘 ≠ 批准", () => {
  async function makeWritableService(manifest: Record<string, { enabled: boolean; sha256?: string }>) {
    const root = await mkdtemp(join(tmpdir(), "yazcode-userscript-p4-"));
    const scriptsDir = join(root, "userscripts");
    const storageRootDir = join(root, "storage");
    await mkdir(scriptsDir, { recursive: true });
    const saved: Array<Record<string, { enabled: boolean; sha256?: string }>> = [];
    let current = manifest;
    const manifestPort: UserscriptManifestPort = {
      async getManifest() {
        return current;
      },
      async saveManifest(next) {
        saved.push(next);
        current = next;
      },
    };
    const service = createUserscriptService({
      scriptsDir,
      storageRootDir,
      manifestPort,
      logger: { info: () => {}, warn: () => {} },
    });
    const storage = createUserscriptStorage({ rootDir: storageRootDir, logger: { warn: () => {} } });
    const files = createUserscriptFiles({
      scriptsDir,
      storage,
      logger: { info: () => {}, warn: () => {} },
    });
    return {
      service,
      files,
      manifestPort,
      saved,
      scriptsDir,
      storage,
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  }

  it("新建写盘后 main 不 patch manifest：状态 disabled（服务集不含）；UI patch 后 pending_approval", async () => {
    const ctx = await makeWritableService({});
    try {
      const content = scriptWithGrant("https://fresh.test/*", "GM_addStyle");
      const write = await ctx.files.writeScript("fresh", content, false);
      assert.equal(write.ok, true);
      // 写盘通道自身不产生任何 manifest 写。
      assert.deepEqual(ctx.saved, []);

      // 发现 ≠ 启用：新文件无条目 → disabled；match 服务集不含该脚本。
      const statusAfterWrite = (await ctx.service.listStatus()).find(
        (item) => item.scriptId === "fresh",
      );
      assert.equal(statusAfterWrite?.status, "disabled");
      const matchResponse = await ctx.service.match(
        { url: "https://fresh.test/page" },
        mainFrameContext,
      );
      assert.deepEqual(matchResponse.scripts, []);

      // 模拟 UI patch（SettingService 唯一写路径）→ pending_approval，仍不服务。
      const currentManifest = await ctx.manifestPort.getManifest();
      await ctx.manifestPort.saveManifest({
        ...currentManifest,
        fresh: { enabled: false, pendingApproval: true },
      });
      const statusAfterPatch = (await ctx.service.listStatus()).find(
        (item) => item.scriptId === "fresh",
      );
      assert.equal(statusAfterPatch?.status, "pending_approval");
      assert.deepEqual(await ctx.service.match({ url: "https://fresh.test/page" }, mainFrameContext), {
        scripts: [],
      });

      // 用户批准（钉住所见 sha）→ 下次扫描 serving。
      const seen = statusAfterPatch?.sha256 ?? "";
      await ctx.manifestPort.saveManifest({
        ...(await ctx.manifestPort.getManifest()),
        fresh: { enabled: true, sha256: seen },
      });
      const statusAfterApprove = (await ctx.service.listStatus()).find(
        (item) => item.scriptId === "fresh",
      );
      assert.equal(statusAfterApprove?.status, "serving");
      const served = await ctx.service.match({ url: "https://fresh.test/page" }, mainFrameContext);
      assert.deepEqual(
        served.scripts.map((item) => item.scriptId),
        ["fresh"],
      );
    } finally {
      await ctx.cleanup();
    }
  });

  it("编辑已批准脚本：manifest 未变（enabled + 旧 sha），状态 hash_mismatch 且不服务", async () => {
    const ctx = await makeWritableService({});
    try {
      const original = scriptWithGrant("https://edit.test/*", "GM_addStyle");
      await ctx.files.writeScript("edited", original, false);
      // 锚定批准（旧内容 hash）。
      const first = (await ctx.service.listStatus()).find((item) => item.scriptId === "edited");
      const anchoredSha = first?.sha256 ?? "";
      await ctx.manifestPort.saveManifest({ edited: { enabled: true, sha256: anchoredSha } });
      assert.equal(
        (await ctx.service.listStatus()).find((item) => item.scriptId === "edited")?.status,
        "serving",
      );

      // 编辑保存（overwrite:true）：断言 manifest 无新写入（保存动作永不写 sha）。
      const savesBefore = ctx.saved.length;
      const editedContent = scriptWithGrant("https://edit.test/*", "GM_addStyle");
      const write = await ctx.files.writeScript(
        "edited",
        `${editedContent}\n// touched\n`,
        true,
      );
      assert.equal(write.ok, true);
      assert.equal(ctx.saved.length, savesBefore, "写盘通道不得写 manifest");

      const status = (await ctx.service.listStatus()).find((item) => item.scriptId === "edited");
      assert.equal(status?.status, "hash_mismatch");
      // manifest 条目仍是 enabled + 旧 sha。
      const entry = (await ctx.manifestPort.getManifest()).edited;
      assert.deepEqual(entry, { enabled: true, sha256: anchoredSha });
      // 不服务（未确认内容不被执行）。
      assert.deepEqual(await ctx.service.match({ url: "https://edit.test/page" }, mainFrameContext), {
        scripts: [],
      });

      // 重新批准（钉住新内容 sha）→ serving。
      await ctx.manifestPort.saveManifest({
        edited: { enabled: true, sha256: status?.sha256 ?? "" },
      });
      assert.equal(
        (await ctx.service.listStatus()).find((item) => item.scriptId === "edited")?.status,
        "serving",
      );
    } finally {
      await ctx.cleanup();
    }
  });

  it("statusOverview 的 storageHealth 仅在存在存储文件时给出（P4 删除流判定依据）", async () => {
    const ctx = await makeWritableService({ svc: { enabled: true, sha256: "" } });
    try {
      // 脚本文件在盘上才有状态行（inspect 以目录扫描为准）。
      const write = await ctx.files.writeScript("svc", scriptWithGrant("https://svc.test/*"), false);
      assert.equal(write.ok, true);
      // 无存储文件：storageHealth 缺席（不是伪造的 ok）。
      const withoutStorage = await ctx.service.statusOverview();
      const svcRow = withoutStorage.find((item) => item.scriptId === "svc");
      assert.ok(svcRow);
      assert.equal("storageHealth" in svcRow, false);

      // 写入 GM 存储 → 出现且为 ok。
      await ctx.storage.setValue("svc", "k", "v");
      const withStorage = await ctx.service.statusOverview();
      const svcWithStorage = withStorage.find((item) => item.scriptId === "svc");
      assert.ok(svcWithStorage);
      assert.equal(svcWithStorage.storageHealth, "ok");
    } finally {
      await ctx.cleanup();
    }
  });
});
