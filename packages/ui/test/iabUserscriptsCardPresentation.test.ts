import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { IabUserscriptStatusItem } from "@zcode/shared";
import {
  buildIabUserscriptRows,
  nextManifestEntry,
  toShaShort,
} from "../src/settings/iabUserscriptsCardPresentation.js";

/** P2 设置卡纯投影（packages/ui/test 无组件渲染基建，测纯函数层）。 */

function statusItem(overrides: Partial<IabUserscriptStatusItem>): IabUserscriptStatusItem {
  return {
    scriptId: "portal",
    name: "portal",
    runAt: "document-start",
    grants: [],
    match: ["https://oa.test/*"],
    status: "disabled",
    sha256: "A1B2C3D4E5F6",
    ...overrides,
  };
}

describe("buildIabUserscriptRows（live 模式）", () => {
  it("各状态映射开关/徽标/批准按钮", () => {
    const rows = buildIabUserscriptRows({
      liveStatus: [
        statusItem({ scriptId: "a", status: "serving" }),
        statusItem({ scriptId: "b", status: "enabled_pending_anchor" }),
        statusItem({ scriptId: "c", status: "hash_mismatch" }),
        statusItem({ scriptId: "d", status: "pending_approval" }),
        statusItem({ scriptId: "e", status: "parse_failed", detail: "bad" }),
        statusItem({ scriptId: "f", status: "grant_rejected" }),
        statusItem({ scriptId: "g", status: "disabled" }),
      ],
      manifest: {},
    });
    const by = (id: string) => rows.find((row) => row.scriptId === id);
    assert.deepEqual(by("a")?.badges, ["serving"]);
    assert.equal(by("a")?.switchChecked, true);
    // enabled_pending_anchor 呈现为「已启用」，锚定是扫描内部动作。
    assert.deepEqual(by("b")?.badges, ["enabled"]);
    assert.equal(by("b")?.switchChecked, true);
    assert.deepEqual(by("c")?.badges, ["hash_mismatch"]);
    assert.equal(by("c")?.switchChecked, false);
    assert.equal(by("d")?.showApprove, true);
    assert.equal(by("d")?.switchChecked, false);
    assert.equal(by("e")?.switchDisabled, true);
    assert.equal(by("f")?.switchDisabled, true);
    assert.equal(by("g")?.switchDisabled, false);
  });

  it("storage_corrupt 与脚本状态正交并存", () => {
    const rows = buildIabUserscriptRows({
      liveStatus: [statusItem({ status: "serving", storageHealth: "corrupt" })],
      manifest: {},
    });
    assert.deepEqual(rows[0]?.badges, ["serving", "storage_corrupt"]);
  });

  it("sha 短码取前 8 位小写 hex", () => {
    const rows = buildIabUserscriptRows({
      liveStatus: [statusItem({ sha256: "ABCDEF0123456789" })],
      manifest: {},
    });
    assert.equal(rows[0]?.shaShort, "abcdef01");
    assert.equal(toShaShort("short"), null);
    assert.equal(toShaShort(undefined), null);
  });

  it("行携带完整 sha256 供批准钉住；读取失败的空串归一 null（M1）", () => {
    const rows = buildIabUserscriptRows({
      liveStatus: [
        statusItem({ scriptId: "ok", sha256: "ABCDEF0123456789" }),
        statusItem({ scriptId: "unreadable", sha256: "" }),
      ],
      manifest: {},
    });
    assert.equal(rows.find((row) => row.scriptId === "ok")?.sha256, "ABCDEF0123456789");
    assert.equal(rows.find((row) => row.scriptId === "unreadable")?.sha256, null);
    // 降级模式行携带 manifest 已锚 hash（钉住它比盲锚当前内容更 fail-closed）。
    const degraded = buildIabUserscriptRows({
      liveStatus: null,
      manifest: { pinned: { enabled: true, sha256: "a1b2c3d4e5f6" } },
    });
    assert.equal(degraded[0]?.sha256, "a1b2c3d4e5f6");
  });
});

describe("buildIabUserscriptRows（降级模式：无平台查询）", () => {
  it("manifest 派生行不猜测 name/mismatch；pendingApproval 保留批准入口", () => {
    const rows = buildIabUserscriptRows({
      liveStatus: null,
      manifest: {
        enabledOne: { enabled: true, sha256: "a1b2c3d4e5f6" },
        pending: { enabled: false, pendingApproval: true },
        off: { enabled: false },
      },
    });
    const by = (id: string) => rows.find((row) => row.scriptId === id);
    assert.equal(by("enabledOne")?.name, "enabledOne");
    assert.equal(by("enabledOne")?.shaShort, "a1b2c3d4");
    assert.deepEqual(by("enabledOne")?.badges, ["enabled"]);
    assert.deepEqual(by("pending")?.badges, ["pending_approval"]);
    assert.equal(by("pending")?.showApprove, true);
    assert.deepEqual(by("off")?.badges, ["disabled"]);
  });

  it("manifest 缺失时返回空行集", () => {
    assert.deepEqual(buildIabUserscriptRows({ liveStatus: null, manifest: undefined }), []);
  });
});

describe("nextManifestEntry（动作 → 下一条目）", () => {
  it("approve 钉住所见 sha（M1：批准即锁内容指纹，关闭批准→首扫锚定窗口）", () => {
    assert.deepEqual(
      nextManifestEntry({ enabled: true, sha256: "a".repeat(64) }, "approve", "b".repeat(64)),
      { enabled: true, sha256: "b".repeat(64) },
    );
    assert.deepEqual(
      nextManifestEntry({ enabled: false, pendingApproval: true }, "approve", "c".repeat(64)),
      { enabled: true, sha256: "c".repeat(64) },
    );
  });

  it("approve 无所见 sha（未扫描/读取失败）回退 {enabled:true} 首扫锚定（窗口固有）", () => {
    assert.deepEqual(nextManifestEntry(undefined, "approve"), { enabled: true });
    assert.deepEqual(nextManifestEntry(undefined, "approve", null), { enabled: true });
    assert.deepEqual(nextManifestEntry(undefined, "approve", ""), { enabled: true });
  });

  it("disable 关闭启用或驳回待批准；无变化返回 null（免写）", () => {
    assert.deepEqual(nextManifestEntry({ enabled: true, sha256: "a".repeat(64) }, "disable"), {
      enabled: false,
    });
    assert.deepEqual(nextManifestEntry({ enabled: false, pendingApproval: true }, "disable"), {
      enabled: false,
    });
    assert.equal(nextManifestEntry({ enabled: false }, "disable"), null);
    assert.deepEqual(nextManifestEntry(undefined, "disable"), { enabled: false });
  });
});
