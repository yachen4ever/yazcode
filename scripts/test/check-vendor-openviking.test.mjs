import assert from "node:assert/strict";
import { test } from "node:test";
import { isTrimmed, localBlobMap } from "../check-vendor-openviking.mjs";

const MAPPING_ROOTS = [
  { local: "vendor/openviking/zcode", upstream: "examples/agent-hook-plugin" },
  {
    local: "vendor/openviking/memory-plugin-shared/lib",
    upstream: "examples/memory-plugin-shared/lib",
  },
];

test("本地文件一律按映射根截取上游路径，深层子目录不得塌缩成扁平路径", () => {
  const map = localBlobMap();
  assert.ok(map.size > 0, "vendor/openviking 目录为空，映射测试失去意义");
  for (const [rel, { upstreamPath }] of map) {
    const root = MAPPING_ROOTS.find(({ local }) => rel.startsWith(`${local}/`));
    assert.ok(root, `本地文件不在任何映射根之下: ${rel}`);
    const expected = `${root.upstream}/${rel.slice(root.local.length + 1)}`;
    assert.equal(upstreamPath, expected, `${rel} 的上游路径映射错位`);
  }
});

test("回归锚：二层文件映射保留子目录段（scripts/ 与 lib/install/）", () => {
  const map = localBlobMap();
  const hook = map.get("vendor/openviking/zcode/scripts/hook.mjs");
  assert.ok(hook, "vendor 缺少 zcode/scripts/hook.mjs，同步结构变化时同步更新本测试");
  assert.equal(hook.upstreamPath, "examples/agent-hook-plugin/scripts/hook.mjs");
  const install = map.get(
    "vendor/openviking/memory-plugin-shared/lib/install/host-json-config.mjs",
  );
  assert.ok(install, "vendor 缺少 lib/install/host-json-config.mjs，同步结构变化时同步更新本测试");
  assert.equal(
    install.upstreamPath,
    "examples/memory-plugin-shared/lib/install/host-json-config.mjs",
  );
});

test("裁剪豁免边界：非 zcode host 与声明文件豁免，LICENSE 永不豁免", () => {
  assert.equal(isTrimmed("examples/agent-hook-plugin/hosts/cursor/.mcp.json"), true);
  assert.equal(isTrimmed("examples/agent-hook-plugin/hosts/cursor.mjs"), true);
  assert.equal(isTrimmed("examples/agent-hook-plugin/tests/zcode.test.mjs"), true);
  assert.equal(isTrimmed("examples/memory-plugin-shared/lib/recall-core.d.mts"), true);
  assert.equal(isTrimmed("examples/agent-hook-plugin/LICENSE"), false);
  assert.equal(isTrimmed("examples/agent-hook-plugin/scripts/hook.mjs"), false);
});

// ── 比对基准选择（26.5.11，issue #43 决策 b）────────────────────────────────────
// latest release 与 main HEAD 之间选「integration 版本与本地 vendored 一致」者
// （release 优先）；均不一致 → 回退 release 并标记 upstreamAhead（正常报告漂移，
// 不得放宽为永久绿）。

test("pickComparisonTarget：release 版本匹配时优先 release", async () => {
  const { pickComparisonTarget } = await import("../check-vendor-openviking.mjs");
  const target = pickComparisonTarget({
    localIntegrationVersion: "0.5.35",
    release: { sha: "r1", tagName: "v0.5.6", integrationVersion: "0.5.35" },
    main: { sha: "m1", tagName: "main@m1", integrationVersion: "0.5.36" },
  });
  assert.equal(target.kind, "release");
  assert.equal(target.sha, "r1");
  assert.equal(target.upstreamAhead, false);
});

test("pickComparisonTarget：main 已 bump、release 未发时选 main（本单场景）", async () => {
  const { pickComparisonTarget } = await import("../check-vendor-openviking.mjs");
  const target = pickComparisonTarget({
    localIntegrationVersion: "0.5.36",
    release: { sha: "r1", tagName: "v0.5.6", integrationVersion: "0.5.35" },
    main: { sha: "m1", tagName: "main@m1", integrationVersion: "0.5.36" },
  });
  assert.equal(target.kind, "main");
  assert.equal(target.sha, "m1");
  assert.equal(target.upstreamAhead, false);
});

test("pickComparisonTarget：均不一致 → 回退 release 并标记 upstreamAhead（真实漂移必报）", async () => {
  const { pickComparisonTarget } = await import("../check-vendor-openviking.mjs");
  const target = pickComparisonTarget({
    localIntegrationVersion: "0.5.36",
    release: { sha: "r2", tagName: "v0.5.7", integrationVersion: "0.5.37" },
    main: { sha: "m2", tagName: "main@m2", integrationVersion: "0.5.37" },
  });
  assert.equal(target.kind, "release");
  assert.equal(target.sha, "r2");
  assert.equal(target.upstreamAhead, true);
});

test("pickComparisonTarget：候选版本缺失（API 读失败）不造成假绿", async () => {
  const { pickComparisonTarget } = await import("../check-vendor-openviking.mjs");
  const target = pickComparisonTarget({
    localIntegrationVersion: "0.5.36",
    release: { sha: "r1", tagName: "v0.5.6", integrationVersion: null },
    main: { sha: "m1", tagName: "main@m1", integrationVersion: null },
  });
  assert.equal(target.upstreamAhead, true);
});

test("readLocalIntegrationVersion：读到 vendored 的 0.5.36", async () => {
  const { readLocalIntegrationVersion } = await import("../check-vendor-openviking.mjs");
  assert.equal(readLocalIntegrationVersion(), "0.5.36");
});
