import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { IabUserscriptStatusItem } from "@zcode/shared";
import {
  badgeTone,
  buildIabUserscriptRows,
  nextManifestEntry,
  partitionIabUserscriptRows,
  toMatchDomains,
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
    assert.equal(by("c")?.showReapprove, true);
    assert.equal(by("c")?.showApprove, false);
    assert.equal(by("d")?.showApprove, true);
    assert.equal(by("d")?.showReapprove, false);
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

  it("降级模式行不猜测扫描事实：域名/detail/注入时刻全为空，也不显示重新批准", () => {
    const rows = buildIabUserscriptRows({
      liveStatus: null,
      manifest: {
        enabledOne: { enabled: true, sha256: "a1b2c3d4e5f6" },
        pending: { enabled: false, pendingApproval: true },
      },
    });
    for (const row of rows) {
      assert.deepEqual(row.matchDomains, []);
      assert.equal(row.detail, null);
      assert.equal(row.lastInjectedAt, null);
      assert.equal(row.showReapprove, false);
    }
  });

  it("manifest 缺失时返回空行集", () => {
    assert.deepEqual(buildIabUserscriptRows({ liveStatus: null, manifest: undefined }), []);
  });
});

describe("P3 行字段：域名 / detail / 注入时刻", () => {
  it("@match 派生域名；parse_failed 的 detail 原文透出", () => {
    const rows = buildIabUserscriptRows({
      liveStatus: [
        statusItem({
          scriptId: "served",
          status: "serving",
          match: ["https://oa.test/*", "*://*.example.com/path*"],
          lastInjectedAt: 1_700_000_000_000,
        }),
        statusItem({
          scriptId: "broken",
          status: "parse_failed",
          match: [],
          detail: "invalid @match pattern: http://127.0.0.1:8642/*",
        }),
      ],
      manifest: {},
    });
    assert.deepEqual(rows.find((row) => row.scriptId === "served")?.matchDomains, [
      "oa.test",
      "*.example.com",
    ]);
    assert.equal(rows.find((row) => row.scriptId === "served")?.lastInjectedAt, 1_700_000_000_000);
    const broken = rows.find((row) => row.scriptId === "broken");
    assert.equal(broken?.detail, "invalid @match pattern: http://127.0.0.1:8642/*");
    assert.deepEqual(broken?.matchDomains, []);
    // 未注入的脚本字段为 null（UI 显示「尚未注入」），不是 0。
    assert.equal(broken?.lastInjectedAt, null);
  });

  it("空白 detail 与缺省同义，不渲染空行", () => {
    const rows = buildIabUserscriptRows({
      liveStatus: [statusItem({ detail: "   " })],
      manifest: {},
    });
    assert.equal(rows[0]?.detail, null);
  });
});

describe("toMatchDomains（@match → 域名）", () => {
  it("去 scheme 与 path：https://oa.test/* → oa.test", () => {
    assert.deepEqual(toMatchDomains(["https://oa.test/*"]), ["oa.test"]);
  });

  it("保留通配前缀：*://*.example.com/path* → *.example.com", () => {
    assert.deepEqual(toMatchDomains(["*://*.example.com/path*"]), ["*.example.com"]);
  });

  it("<all_urls> 原样保留", () => {
    assert.deepEqual(toMatchDomains(["<all_urls>"]), ["<all_urls>"]);
  });

  it("多条去重保序", () => {
    assert.deepEqual(
      toMatchDomains([
        "https://b.test/*",
        "http://a.test/x*",
        "https://b.test/other*",
        "*://*.c.test/*",
      ]),
      ["b.test", "a.test", "*.c.test"],
    );
  });

  it("无法解析的条目原样保留（不猜）", () => {
    assert.deepEqual(toMatchDomains(["not a pattern", "ftp://files.test/*"]), [
      "not a pattern",
      "ftp://files.test/*",
    ]);
  });

  it("空数组与空串条目被忽略", () => {
    assert.deepEqual(toMatchDomains([]), []);
    assert.deepEqual(toMatchDomains(["", "   "]), []);
  });
});

describe("partitionIabUserscriptRows（待批准置顶分区）", () => {
  it("pending_approval 单独归入 pending，其余进 others；不丢行不重复", () => {
    const rows = buildIabUserscriptRows({
      liveStatus: [
        statusItem({ scriptId: "a", status: "serving" }),
        statusItem({ scriptId: "b", status: "pending_approval" }),
        statusItem({ scriptId: "c", status: "disabled" }),
        statusItem({ scriptId: "d", status: "pending_approval" }),
      ],
      manifest: {},
    });
    const { pending, others } = partitionIabUserscriptRows(rows);
    assert.deepEqual(
      pending.map((row) => row.scriptId),
      ["b", "d"],
    );
    assert.deepEqual(
      others.map((row) => row.scriptId),
      ["a", "c"],
    );
    assert.equal(pending.length + others.length, rows.length);
    // 分区只做归类，不重排序（组内保持原顺序）。
    assert.deepEqual(
      [...pending, ...others].map((row) => row.scriptId).sort(),
      rows.map((row) => row.scriptId).sort(),
    );
  });

  it("全为普通行时 pending 为空", () => {
    const rows = buildIabUserscriptRows({
      liveStatus: [statusItem({ scriptId: "a", status: "serving" })],
      manifest: {},
    });
    assert.deepEqual(partitionIabUserscriptRows(rows).pending, []);
  });
});

describe("badgeTone（颜色即语义）", () => {
  it("serving→success；pending_approval→warning", () => {
    assert.equal(badgeTone("serving"), "success");
    assert.equal(badgeTone("pending_approval"), "warning");
  });

  it("hash_mismatch / parse_failed / grant_rejected / storage_corrupt→destructive", () => {
    const kinds = ["hash_mismatch", "parse_failed", "grant_rejected", "storage_corrupt"] as const;
    for (const kind of kinds) {
      assert.equal(badgeTone(kind), "destructive");
    }
  });

  it("enabled / disabled→neutral（灰色只用于无活动状态）", () => {
    assert.equal(badgeTone("enabled"), "neutral");
    assert.equal(badgeTone("disabled"), "neutral");
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
