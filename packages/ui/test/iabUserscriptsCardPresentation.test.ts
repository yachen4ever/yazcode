import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { IabUserscriptStatusItem } from "@zcode/shared";
import {
  badgeTone,
  buildIabUserscriptRows,
  buildNewScriptTemplate,
  deriveScriptIdFromFilename,
  nextManifestEntry,
  nextManifestEntryAfterSave,
  partitionIabUserscriptRows,
  suggestAlternateScriptId,
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

/**
 * P4 自助管理纯函数（docs/specs/iab-userscripts.md P4）：
 * 新建模板（两个实战要点）、文件名 stem 派生、另存候选、
 * 保存语义（红线 1/2：已锚定不写、其余落 pendingApproval、永不写 sha）。
 */
describe("nextManifestEntryAfterSave（P4 保存语义）", () => {
  it("已锚定条目（enabled ∧ sha256）→ null：不写 manifest，扫描自然落 hash_mismatch", () => {
    assert.equal(nextManifestEntryAfterSave({ enabled: true, sha256: "a".repeat(64) }), null);
  });

  it("其余全部落 {enabled:false, pendingApproval:true}（含 pending_approval/disabled/无条目）", () => {
    assert.deepEqual(nextManifestEntryAfterSave(undefined), {
      enabled: false,
      pendingApproval: true,
    });
    assert.deepEqual(nextManifestEntryAfterSave({ enabled: false }), {
      enabled: false,
      pendingApproval: true,
    });
    assert.deepEqual(nextManifestEntryAfterSave({ enabled: false, pendingApproval: true }), {
      enabled: false,
      pendingApproval: true,
    });
  });

  it("enabled 无 sha（enabled_pending_anchor 窄窗口）也落 pendingApproval：不 patch 会被扫描锚定新内容并直接服务，违反红线 1", () => {
    assert.deepEqual(nextManifestEntryAfterSave({ enabled: true }), {
      enabled: false,
      pendingApproval: true,
    });
  });

  it("任何保存路径都不产生 {enabled:true} 组合（红线 2：保存永不写 sha256）", () => {
    const entries = [
      nextManifestEntryAfterSave(undefined),
      nextManifestEntryAfterSave({ enabled: false }),
      nextManifestEntryAfterSave({ enabled: true }),
      nextManifestEntryAfterSave({ enabled: true, sha256: "a".repeat(64) }),
    ];
    for (const entry of entries) {
      if (entry === null) continue; // 已锚定条目不写 manifest（红线 1 第二分支）
      assert.equal(entry.enabled, false);
      assert.equal(entry.sha256, undefined);
    }
  });
});

describe("buildNewScriptTemplate（P4 模板）", () => {
  const hints = {
    name: "新脚本",
    matchHint: "MATCH-HINT 裸 host 不带端口",
    frameHint: "FRAME-HINT 按 frame 注入",
  };

  it("结构完整：元数据块起止、@match 裸 host 示例、@grant none", () => {
    const template = buildNewScriptTemplate(hints);
    assert.match(template, /^\/\/ ==UserScript==/m);
    assert.match(template, /\/\/ ==\/UserScript==/m);
    // 裸 host 示例：host 不带端口（带端口的 pattern 编译期拒绝，实战踩坑第一来源）。
    assert.match(template, /@match https:\/\/example\.com\/\*/);
    assert.doesNotMatch(template, /@match https?:\/\/[^/\s]*:\d+/);
    assert.match(template, /@grant none/);
    assert.match(template, /@name 新脚本/);
  });

  it("两个实战要点作为注释写入模板（i18n 文案由调用方传入）", () => {
    const template = buildNewScriptTemplate(hints);
    assert.match(template, /\/\/ MATCH-HINT 裸 host 不带端口/);
    assert.match(template, /\/\/ FRAME-HINT 按 frame 注入/);
  });
});

describe("deriveScriptIdFromFilename（P4 导入）", () => {
  it("取 .user.js 的 stem；大小写不敏感识别后缀", () => {
    assert.equal(deriveScriptIdFromFilename("portal.user.js"), "portal");
    assert.equal(deriveScriptIdFromFilename("Portal.USER.JS"), "Portal");
    assert.equal(deriveScriptIdFromFilename("my.tool.v2.user.js"), "my.tool.v2");
  });

  it("无后缀 / 仅后缀 / 空串返回 null（调用方提示改 ID）", () => {
    assert.equal(deriveScriptIdFromFilename("script.js"), null);
    assert.equal(deriveScriptIdFromFilename(".user.js"), null);
    assert.equal(deriveScriptIdFromFilename(""), null);
  });
});

describe("suggestAlternateScriptId（P4 另存）", () => {
  it("追加 -2 起，跳过已占用；base 为空返回 null", () => {
    assert.equal(suggestAlternateScriptId("portal", ["portal"]), "portal-2");
    assert.equal(suggestAlternateScriptId("portal", ["portal", "portal-2"]), "portal-3");
    assert.equal(suggestAlternateScriptId("portal", []), "portal-2");
    assert.equal(suggestAlternateScriptId("", ["portal"]), null);
  });
});

describe("P4 行字段 hasStorageFile（删除流第二个确认框依据）", () => {
  it("live 模式：storageHealth 给出（有存储文件）→ true；缺席（无存储）→ false", () => {
    const rows = buildIabUserscriptRows({
      liveStatus: [
        statusItem({ scriptId: "with", storageHealth: "ok" }),
        statusItem({ scriptId: "without" }),
      ],
      manifest: {},
    });
    assert.equal(rows.find((row) => row.scriptId === "with")?.hasStorageFile, true);
    assert.equal(rows.find((row) => row.scriptId === "without")?.hasStorageFile, false);
  });

  it("降级模式恒 false（工具行本就不渲染，不猜测存储事实）", () => {
    const rows = buildIabUserscriptRows({
      liveStatus: null,
      manifest: { one: { enabled: true, sha256: "a1b2c3d4e5f6" } },
    });
    assert.equal(rows[0]?.hasStorageFile, false);
  });
});
