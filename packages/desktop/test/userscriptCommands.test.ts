import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { maybeHandleUserscriptCommand } from "../src/main/browserView/browserCommandUserscriptsHandler.js";
import { createUserscriptService } from "../src/main/userscripts/userscriptService.js";
import {
  computeScriptSha256,
  type UserscriptManifestEntry,
  type UserscriptManifestPort,
} from "../src/main/userscripts/userscriptStore.js";

/**
 * P2 命令面 + 确认流契约（docs/specs/iab-userscripts.md P2 验收场景 2/3/5/6/7/8）：
 * agent set_enabled(true) 只落 pendingApproval 不执行；用户批准 = 钉住所见 sha 的
 * {enabled:true, sha256}（M1），无所见 sha 回退首扫锚定；reload/listStatus 幂等且只读。
 */

function scriptBody(name: string, match: string): string {
  return `// ==UserScript==\n// @name ${name}\n// @match ${match}\n// ==/UserScript==\nvoid 0;\n`;
}

/** 可写 manifest 端口：捕获保存结果（状态机断言用）。 */
function mutableManifestPort(initial: Record<string, UserscriptManifestEntry>): {
  port: UserscriptManifestPort;
  saves: Array<Record<string, UserscriptManifestEntry>>;
  current: () => Record<string, UserscriptManifestEntry>;
} {
  let value = initial;
  const saves: Array<Record<string, UserscriptManifestEntry>> = [];
  return {
    port: {
      async getManifest() {
        return value;
      },
      async saveManifest(manifest) {
        value = manifest;
        saves.push(manifest);
      },
    },
    saves,
    current: () => value,
  };
}

async function makeFixture(manifest: Record<string, UserscriptManifestEntry>) {
  const root = await mkdtemp(join(tmpdir(), "yazcode-userscript-cmd-"));
  const scriptsDir = join(root, "userscripts");
  await mkdir(scriptsDir, { recursive: true });
  await writeFile(join(scriptsDir, "portal.user.js"), scriptBody("portal", "https://oa.test/*"));
  const anchorable = scriptBody("drift", "https://drift.test/*");
  await writeFile(join(scriptsDir, "drift.user.js"), anchorable);
  // 场景 7 显式用例的载体：初始无 manifest 条目，用例内自置 {enabled:true}（无 sha）。
  await writeFile(
    join(scriptsDir, "anchor-pending.user.js"),
    scriptBody("anchor-pending", "https://anchor.test/*"),
  );
  const manifestPort = mutableManifestPort(manifest);
  const service = createUserscriptService({
    scriptsDir,
    storageRootDir: join(root, "storage"),
    manifestPort: manifestPort.port,
    logger: { info: () => {}, warn: () => {} },
  });
  return {
    service,
    manifestPort,
    scriptsDir,
    driftContent: anchorable,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

describe("userscriptService 命令面（确认流）", () => {
  let fixture: Awaited<ReturnType<typeof makeFixture>>;
  before(async () => {
    fixture = await makeFixture({ drift: { enabled: true } });
    // 首扫锚定 drift（P1 语义），获得可制造 hash mismatch 的基线。
    await fixture.service.reload();
  });
  after(async () => {
    await fixture.cleanup();
  });

  it("listStatus 是只读投影：不产生 manifest 写", async () => {
    const savesBefore = fixture.manifestPort.saves.length;
    const statuses = await fixture.service.listStatus();
    assert.equal(fixture.manifestPort.saves.length, savesBefore);
    const portal = statuses.find((item) => item.scriptId === "portal");
    assert.ok(portal);
    assert.equal(portal.status, "disabled");
    assert.equal(portal.name, "portal");
    assert.deepEqual(portal.match, ["https://oa.test/*"]);
    assert.match(portal.sha256, /^[0-9a-f]{64}$/);
    // 回包不含代码与路径。
    assert.ok(!("code" in portal) && !("path" in portal));
    const drift = statuses.find((item) => item.scriptId === "drift");
    assert.equal(drift?.status, "serving");
  });

  it("agent set_enabled(true) 只落 pendingApproval，不进入服务集（验收场景 2）", async () => {
    const result = await fixture.service.setAgentEnabled("portal", true);
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.equal(result.status.status, "pending_approval");
    assert.deepEqual(fixture.manifestPort.current().portal, {
      enabled: false,
      pendingApproval: true,
    });
    const statuses = await fixture.service.listStatus();
    assert.equal(statuses.find((item) => item.scriptId === "portal")?.status, "pending_approval");
  });

  it("对已批准态 set_enabled(true) 幂等 no-op，不写 manifest（验收场景 5 语义）", async () => {
    const savesBefore = fixture.manifestPort.saves.length;
    const result = await fixture.service.setAgentEnabled("drift", true);
    assert.equal(result.ok, true);
    assert.equal(result.changed, false);
    assert.equal(result.status.status, "serving");
    assert.equal(fixture.manifestPort.saves.length, savesBefore);
  });

  it("agent set_enabled(false) 降权直达：立即停用并清 sha/pendingApproval（验收场景 6）", async () => {
    const result = await fixture.service.setAgentEnabled("drift", false);
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.deepEqual(fixture.manifestPort.current().drift, { enabled: false });
    const statuses = await fixture.service.listStatus();
    assert.equal(statuses.find((item) => item.scriptId === "drift")?.status, "disabled");
  });

  it("未知 scriptId 返回 unknown_script（验收场景 1 边界在 handler 侧映射 ref_not_found）", async () => {
    const result = await fixture.service.setAgentEnabled("missing", true);
    assert.deepEqual(result, { ok: false, error: "unknown_script" });
  });

  it("用户批准语义：外部（设置卡路径）把条目改回 {enabled:true} 后 reload 锚定并服务（验收场景 3）", async () => {
    await fixture.manifestPort.port.saveManifest({
      ...fixture.manifestPort.current(),
      portal: { enabled: true },
    });
    const statuses = await fixture.service.reload();
    const portal = statuses.find((item) => item.scriptId === "portal");
    assert.equal(portal?.status, "serving");
    const entry = fixture.manifestPort.current().portal;
    assert.equal(entry.enabled, true);
    assert.match(entry.sha256 ?? "", /^[0-9a-f]{64}$/);
    assert.notEqual(entry.sha256, undefined);
  });

  it("hash mismatch 停服后状态呈现，agent set_enabled(true) 仍只落待批准（验收场景 4）", async () => {
    const anchored = fixture.manifestPort.current().portal;
    assert.ok(anchored.sha256);
    // 内容变更：同 scriptId 写入不同内容。
    await writeFile(
      join(fixture.scriptsDir, "portal.user.js"),
      scriptBody("portal-v2", "https://oa.test/*"),
    );
    let statuses = await fixture.service.listStatus();
    assert.equal(statuses.find((item) => item.scriptId === "portal")?.status, "hash_mismatch");

    const result = await fixture.service.setAgentEnabled("portal", true);
    assert.equal(result.status.status, "pending_approval");
    assert.deepEqual(fixture.manifestPort.current().portal, {
      enabled: false,
      pendingApproval: true,
    });
    statuses = await fixture.service.listStatus();
    assert.equal(statuses.find((item) => item.scriptId === "portal")?.status, "pending_approval");
  });

  it("reload 幂等：连续两次返回同构状态，无额外 manifest 写（验收场景 5）", async () => {
    const first = await fixture.service.reload();
    const savesBefore = fixture.manifestPort.saves.length;
    const second = await fixture.service.reload();
    assert.equal(fixture.manifestPort.saves.length, savesBefore);
    assert.deepEqual(
      second.map((item) => [item.scriptId, item.status]),
      first.map((item) => [item.scriptId, item.status]),
    );
  });

  it("listStatus 对 enabled 无 sha 条目只读返回 enabled_pending_anchor，无锚定写（验收场景 7 显式，M5）", async () => {
    // manifest 仅 {enabled:true}（无 sha）：状态查询是只读投影，不得成为隐藏批准动作。
    await fixture.manifestPort.port.saveManifest({
      ...fixture.manifestPort.current(),
      "anchor-pending": { enabled: true },
    });
    const savesBefore = fixture.manifestPort.saves.length;
    const statuses = await fixture.service.listStatus();
    assert.equal(fixture.manifestPort.saves.length, savesBefore);
    const item = statuses.find((entry) => entry.scriptId === "anchor-pending");
    assert.ok(item);
    assert.equal(item.status, "enabled_pending_anchor");
    // manifest 无额外写入：不产生锚定 sha，条目保持裸 {enabled:true}。
    assert.deepEqual(fixture.manifestPort.current()["anchor-pending"], { enabled: true });
  });
});

describe("用户批准钉住所见 sha（P2 复核 M1）", () => {
  let fixture: Awaited<ReturnType<typeof makeFixture>>;
  let approvedSha: string;
  before(async () => {
    fixture = await makeFixture({});
    const content = await readFile(join(fixture.scriptsDir, "portal.user.js"));
    approvedSha = computeScriptSha256(content);
    // 模拟设置卡 M1 批准：patch {enabled:true, sha256:<liveStatus 所见>}（不再清 sha）。
    await fixture.manifestPort.port.saveManifest({
      portal: { enabled: true, sha256: approvedSha },
    });
  });
  after(async () => {
    await fixture.cleanup();
  });

  it("批准后文件未改：sha 一致直接服务，且无首扫锚定写", async () => {
    const savesBefore = fixture.manifestPort.saves.length;
    const statuses = await fixture.service.reload();
    assert.equal(statuses.find((item) => item.scriptId === "portal")?.status, "serving");
    assert.equal(fixture.manifestPort.saves.length, savesBefore);
    assert.deepEqual(fixture.manifestPort.current().portal, {
      enabled: true,
      sha256: approvedSha,
    });
  });

  it("批准后文件被改：hash_mismatch 停服不服务，未确认内容不被锚定（关闭红线窗口）", async () => {
    await writeFile(
      join(fixture.scriptsDir, "portal.user.js"),
      scriptBody("portal-v2", "https://oa.test/*"),
    );
    const statuses = await fixture.service.reload();
    assert.equal(statuses.find((item) => item.scriptId === "portal")?.status, "hash_mismatch");
    const match = await fixture.service.match(
      { url: "https://oa.test/page" },
      { isMainFrame: true, isAllowedSender: true },
    );
    assert.deepEqual(match.scripts, []);
    // manifest 保持批准时钉住的 sha，未被改写为当前（未确认）内容。
    assert.deepEqual(fixture.manifestPort.current().portal, {
      enabled: true,
      sha256: approvedSha,
    });
  });
});

describe("browserCommandUserscriptsHandler", () => {
  it("非 userscript 命令返回 null（交回原命令链路）", async () => {
    assert.equal(await maybeHandleUserscriptCommand({ method: "navigate", url: "https://a.test" }, null), null);
    assert.equal(await maybeHandleUserscriptCommand(null, null), null);
  });

  it("服务未安装（port=null）返回 backend_unavailable（验收场景 8）", async () => {
    for (const command of [
      { method: "userscript_list" },
      { method: "userscript_reload" },
      { method: "userscript_set_enabled", scriptId: "portal", enabled: true },
    ]) {
      const result = await maybeHandleUserscriptCommand(command, null);
      assert.ok(result);
      assert.equal(result.ok, false);
      assert.equal(result.error?.code, "backend_unavailable");
    }
  });

  it("set_enabled 参数兜底校验：空 scriptId / 非布尔 enabled 拒绝", async () => {
    const port = {
      listStatus: async () => [],
      reload: async () => [],
      setAgentEnabled: async () => ({ ok: false as const, error: "unknown_script" as const }),
    };
    for (const bad of [
      { method: "userscript_set_enabled", scriptId: "  ", enabled: true },
      { method: "userscript_set_enabled", scriptId: "portal", enabled: "yes" },
    ]) {
      const result = await maybeHandleUserscriptCommand(bad, port);
      assert.ok(result);
      assert.equal(result.ok, false);
      assert.equal(result.error?.code, "execution_error");
    }
  });

  it("list 返回 value.scripts；set_enabled 未知脚本映射 ref_not_found", async () => {
    const port = {
      listStatus: async () => [
        {
          scriptId: "portal",
          name: "portal",
          runAt: "document-start" as const,
          grants: [],
          match: ["https://oa.test/*"],
          status: "disabled" as const,
          sha256: "a".repeat(64),
        },
      ],
      reload: async () => [],
      setAgentEnabled: async () => ({ ok: false as const, error: "unknown_script" as const }),
    };
    const listResult = await maybeHandleUserscriptCommand({ method: "userscript_list" }, port);
    assert.ok(listResult?.ok);
    assert.equal((listResult?.value as { scripts: unknown[] }).scripts.length, 1);

    const setResult = await maybeHandleUserscriptCommand(
      { method: "userscript_set_enabled", scriptId: "missing", enabled: true },
      port,
    );
    assert.ok(setResult);
    assert.equal(setResult.ok, false);
    assert.equal(setResult.error?.code, "ref_not_found");
  });

  it("port 抛错映射 execution_error，不向调用方 throw", async () => {
    const port = {
      listStatus: async () => {
        throw new Error("boom");
      },
      reload: async () => [],
      setAgentEnabled: async () => ({ ok: false as const, error: "unknown_script" as const }),
    };
    const result = await maybeHandleUserscriptCommand({ method: "userscript_list" }, port);
    assert.ok(result);
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "execution_error");
    assert.equal(result.error?.message, "boom");
  });
});
