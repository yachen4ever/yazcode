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
