import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRegistryRefreshFreshness } from "./registry-refresh-freshness.js";

/**
 * Registry 刷新新鲜度凭据（26.5.9 修复批，spec probe-registry-refresh-dedup.md）：
 * 探测侧跳过自身刷新的前提是「最近一次 refresh 已覆盖当前 config 源」。
 * 任何无法自证的状态（从未刷新 / refresh 后 config 又变了）都必须返回 false，
 * 让调用方照旧刷新（fail-open 安全侧）——26.5.8 的退化（跳过刷新读旧 Base URL）
 * 正因缺少这层自证。
 */

describe("createRegistryRefreshFreshness", () => {
  it("从未刷新：不新鲜（调用方必须自行刷新）", () => {
    const freshness = createRegistryRefreshFreshness();
    assert.equal(freshness.isCurrent(), false);
  });

  it("refresh 完成且之后无 config 变更：新鲜（可跳过）", () => {
    const freshness = createRegistryRefreshFreshness();
    freshness.markRefreshCurrent();
    assert.equal(freshness.isCurrent(), true);
  });

  it("refresh 之后 config 源变化：不新鲜（必须再刷新——26.5.8 退化形态）", () => {
    const freshness = createRegistryRefreshFreshness();
    freshness.markRefreshCurrent();
    // 保存 Base URL 落盘 → config 源变更事件
    freshness.noteConfigChange();
    assert.equal(freshness.isCurrent(), false);
  });

  it("config 变化后再完成一次 refresh：恢复新鲜", () => {
    const freshness = createRegistryRefreshFreshness();
    freshness.markRefreshCurrent();
    freshness.noteConfigChange();
    freshness.markRefreshCurrent();
    assert.equal(freshness.isCurrent(), true);
  });

  it("连续多次 config 变更只需一次 refresh 覆盖", () => {
    const freshness = createRegistryRefreshFreshness();
    freshness.noteConfigChange();
    freshness.noteConfigChange();
    freshness.markRefreshCurrent();
    assert.equal(freshness.isCurrent(), true);
  });
});
