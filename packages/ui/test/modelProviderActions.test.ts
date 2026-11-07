import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { refreshModelProviderSection } from "../src/settings/model-provider-section/modelProviderActions.js";

/**
 * 手动刷新聚合语义（26.5.4 增补批 ③a，spec docs/specs/model-provider-section-a11y.md）：
 * 双成功 = true、任一失败 = false、teamPlan 缺席 = 仅看 provider refresh、
 * 拒绝也算失败（Promise.all 快速失败不得把失败吞成成功）。
 */

describe("refreshModelProviderSection 聚合语义", () => {
  it("双成功返回 true", async () => {
    const ok = await refreshModelProviderSection({
      refresh: async () => true,
      refreshTeamPlanProducts: async () => undefined,
    });
    assert.equal(ok, true);
  });

  it("provider refresh 失败返回 false（teamPlan 成功不掩盖）", async () => {
    const ok = await refreshModelProviderSection({
      refresh: async () => false,
      refreshTeamPlanProducts: async () => undefined,
    });
    assert.equal(ok, false);
  });

  it("teamPlan 拒绝按失败聚合（不吞成成功）", async () => {
    const ok = await refreshModelProviderSection({
      refresh: async () => true,
      refreshTeamPlanProducts: async () => {
        throw new Error("team plan unavailable");
      },
    });
    assert.equal(ok, false);
  });

  it("teamPlan 缺席时仅看 provider refresh", async () => {
    assert.equal(await refreshModelProviderSection({ refresh: async () => true }), true);
    assert.equal(await refreshModelProviderSection({ refresh: async () => false }), false);
  });
});
