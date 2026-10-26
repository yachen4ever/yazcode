import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildV4ComposerDraftStorageKey } from "../src/v4/composer/composerDraftStore.js";

/**
 * P3d 草稿隔离键（docs/specs/multi-root-projects.md「P3d 草稿隔离」）：
 * 同 cwd 双项目不串草稿；无项目上下文回落原键，存量草稿（无项目段）继续可读。
 */

describe("buildV4ComposerDraftStorageKey", () => {
  it("workspaceKey = workspaceIdentity?.trim() || workspacePath（全局统一口径）", () => {
    assert.equal(
      buildV4ComposerDraftStorageKey("/repos/alpha", undefined),
      "zcode-v4-composer-drafts:v1:%2Frepos%2Falpha",
    );
    assert.equal(
      buildV4ComposerDraftStorageKey("/repos/alpha", "  "),
      "zcode-v4-composer-drafts:v1:%2Frepos%2Falpha",
    );
    assert.equal(
      buildV4ComposerDraftStorageKey("/repos/alpha", "remote-1"),
      "zcode-v4-composer-drafts:v1:remote-1",
    );
  });

  it("同 cwd 双项目键不同；不同项目各自稳定", () => {
    const base = buildV4ComposerDraftStorageKey("/repos/alpha");
    const projectA = buildV4ComposerDraftStorageKey("/repos/alpha", undefined, "proj_a");
    const projectB = buildV4ComposerDraftStorageKey("/repos/alpha", undefined, "proj_b");
    assert.notEqual(projectA, projectB);
    assert.notEqual(projectA, base);
    assert.equal(
      projectA,
      buildV4ComposerDraftStorageKey("/repos/alpha", undefined, "proj_a"),
    );
    assert.equal(projectA, "zcode-v4-composer-drafts:v1:%2Frepos%2Falpha#p:proj_a");
  });

  it("空白/空串项目 id 视为无项目段（回落原键，存量草稿可读）", () => {
    const base = buildV4ComposerDraftStorageKey("/repos/alpha");
    assert.equal(buildV4ComposerDraftStorageKey("/repos/alpha", undefined, ""), base);
    assert.equal(buildV4ComposerDraftStorageKey("/repos/alpha", undefined, "   "), base);
    assert.equal(buildV4ComposerDraftStorageKey("/repos/alpha", undefined, null), base);
    assert.equal(buildV4ComposerDraftStorageKey("/repos/alpha", undefined, undefined), base);
  });
});
