import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  browserCommandMethodSchema,
  browserCommandSchema,
  embeddedBrowserUserscriptsSettingsSchema,
} from "@zcode/shared";

/** P2 验收场景 1：三命令 schema 边界（strict、空 scriptId 拒、pendingApproval 兼容）。 */
describe("browserCommandSchema userscript 分支", () => {
  it("接受三命令的最小合法形态", () => {
    assert.equal(
      browserCommandSchema.safeParse({ method: "userscript_list" }).success,
      true,
    );
    assert.equal(
      browserCommandSchema.safeParse({ method: "userscript_reload" }).success,
      true,
    );
    assert.equal(
      browserCommandSchema.safeParse({
        method: "userscript_set_enabled",
        scriptId: "portal-cleaner",
        enabled: true,
      }).success,
      true,
    );
  });

  it("method 枚举同步登记（缺登记即断链）", () => {
    for (const method of ["userscript_list", "userscript_reload", "userscript_set_enabled"]) {
      assert.equal(browserCommandMethodSchema.safeParse(method).success, true);
    }
  });

  it("拒绝未知字段（strict）", () => {
    assert.equal(
      browserCommandSchema.safeParse({ method: "userscript_list", tabId: "t1" }).success,
      false,
    );
    assert.equal(
      browserCommandSchema.safeParse({ method: "userscript_reload", extra: 1 }).success,
      false,
    );
    assert.equal(
      browserCommandSchema.safeParse({
        method: "userscript_set_enabled",
        scriptId: "portal-cleaner",
        enabled: true,
        approve: true,
      }).success,
      false,
    );
  });

  it("拒绝空 scriptId 与非布尔 enabled", () => {
    assert.equal(
      browserCommandSchema.safeParse({ method: "userscript_set_enabled", scriptId: "", enabled: true })
        .success,
      false,
    );
    assert.equal(
      browserCommandSchema.safeParse({ method: "userscript_set_enabled", scriptId: "  ", enabled: true })
        .success,
      false,
    );
    assert.equal(
      browserCommandSchema.safeParse({ method: "userscript_set_enabled", scriptId: "a", enabled: "yes" })
        .success,
      false,
    );
    assert.equal(
      browserCommandSchema.safeParse({ method: "userscript_set_enabled", scriptId: "a" }).success,
      false,
    );
  });
});

describe("embeddedBrowserUserscripts pendingApproval（P2 确认流 schema）", () => {
  it("接受带 pendingApproval 的条目；旧条目缺省兼容", () => {
    const parsed = embeddedBrowserUserscriptsSettingsSchema.safeParse({
      portal: { enabled: false, pendingApproval: true },
      legacy: { enabled: true, sha256: "a".repeat(64) },
    });
    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.equal(parsed.data.portal?.pendingApproval, true);
      assert.equal(parsed.data.legacy?.pendingApproval, undefined);
    }
  });

  it("pendingApproval 非布尔时整条目降级为禁用（catch 语义，不连累其他条目）", () => {
    const parsed = embeddedBrowserUserscriptsSettingsSchema.safeParse({
      bad: { enabled: true, pendingApproval: "yes" },
      good: { enabled: true },
    });
    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.deepEqual(parsed.data.bad, { enabled: false });
      assert.equal(parsed.data.good?.enabled, true);
    }
  });
});
