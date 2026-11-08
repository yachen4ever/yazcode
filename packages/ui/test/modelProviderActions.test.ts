import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProviderSettingsFormProvider } from "@zcode/shared";
import {
  probeProviderConnectivity,
  refreshModelProviderSection,
} from "../src/settings/model-provider-section/modelProviderActions.js";

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

describe("probeProviderConnectivity（26.5.5 发现 1 连通性复核）", () => {
  const makeProvider = (overrides: {
    providerId: string;
    enabled?: boolean;
    executable?: boolean;
    models?: Array<{ modelId: string; config: { enabled?: boolean }; executable?: boolean }>;
  }) =>
    ({
      providerId: overrides.providerId,
      enabled: overrides.enabled ?? true,
      executable: overrides.executable ?? true,
      models: overrides.models ?? [
        { modelId: `${overrides.providerId}-model`, config: {}, executable: true },
      ],
    }) as unknown as ProviderSettingsFormProvider;

  it("全部探测成功 → 返回空集", async () => {
    const failed = await probeProviderConnectivity({
      providers: [makeProvider({ providerId: "a" }), makeProvider({ providerId: "b" })],
      probe: async () => ({ success: true }),
      timeoutMs: 200,
    });
    assert.equal(failed.size, 0);
  });

  it("success=false 与抛错都计入失败集", async () => {
    const failed = await probeProviderConnectivity({
      providers: [makeProvider({ providerId: "a" }), makeProvider({ providerId: "b" })],
      probe: async (providerId) => {
        if (providerId === "a") return { success: false };
        throw new Error("connection refused");
      },
      timeoutMs: 200,
    });
    assert.deepEqual([...failed].sort(), ["a", "b"]);
  });

  it("黑洞挂起被超时兜底计入失败（且探测参数取首个可用模型）", async () => {
    const probed: Array<[string, string]> = [];
    const failed = await probeProviderConnectivity({
      providers: [
        makeProvider({
          providerId: "blackhole",
          models: [
            { modelId: "disabled-model", config: { enabled: false }, executable: true },
            { modelId: "usable-model", config: {}, executable: true },
          ],
        }),
      ],
      probe: (providerId, modelId) => {
        probed.push([providerId, modelId]);
        return new Promise(() => {});
      },
      timeoutMs: 30,
    });
    assert.deepEqual([...failed], ["blackhole"]);
    assert.deepEqual(probed, [["blackhole", "usable-model"]]);
  });

  it("禁用与无可用模型的 provider 跳过探测、不计失败", async () => {
    let probeCalls = 0;
    const failed = await probeProviderConnectivity({
      providers: [
        makeProvider({ providerId: "off", enabled: false }),
        makeProvider({ providerId: "notready", executable: false }),
        makeProvider({
          providerId: "nomodel",
          models: [{ modelId: "m", config: { enabled: false }, executable: true }],
        }),
      ],
      probe: async () => {
        probeCalls += 1;
        return { success: true };
      },
      timeoutMs: 200,
    });
    assert.equal(probeCalls, 0);
    assert.equal(failed.size, 0);
  });
});
