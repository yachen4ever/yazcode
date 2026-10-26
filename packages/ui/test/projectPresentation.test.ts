import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProjectRecord } from "@zcode/services";
import {
  additionalRootsOf,
  leafNameOf,
  orderedRootsOf,
  primaryRootOf,
  projectDisplayName,
  projectRootsBadgeCount,
  resolveProjectForWorkspacePath,
} from "../src/lib/projectPresentation.js";

/** 多目录项目 P3a 呈现层纯函数（packages/ui/test 无组件渲染基建，测纯函数层）。 */

function project(overrides: Partial<ProjectRecord> & { roots?: ProjectRecord["roots"] }): ProjectRecord {
  return {
    projectId: overrides.projectId ?? "proj_a",
    hostId: "local",
    name: overrides.name ?? "",
    defaultName: overrides.defaultName ?? null,
    pinned: overrides.pinned ?? false,
    roots:
      overrides.roots ??
      (overrides.projectId ? [] : [{ rootPath: "/repos/alpha", position: 0, isPrimary: true }]),
  };
}

describe("primaryRootOf / additionalRootsOf / orderedRootsOf", () => {
  it("主目录取 isPrimary，缺失回落首个 root", () => {
    assert.equal(
      primaryRootOf(
        project({
          roots: [
            { rootPath: "/repos/a", position: 0, isPrimary: false },
            { rootPath: "/repos/b", position: 1, isPrimary: true },
          ],
        }),
      ),
      "/repos/b",
    );
    assert.equal(
      primaryRootOf(
        project({
          roots: [
            { rootPath: "/repos/a", position: 0, isPrimary: false },
            { rootPath: "/repos/b", position: 1, isPrimary: false },
          ],
        }),
      ),
      "/repos/a",
    );
    assert.equal(primaryRootOf(project({ roots: [] })), null);
  });

  it("附加目录有序且排除主目录", () => {
    const record = project({
      roots: [
        { rootPath: "/repos/main", position: 0, isPrimary: false },
        { rootPath: "/repos/primary", position: 1, isPrimary: true },
        { rootPath: "/repos/lib", position: 2, isPrimary: false },
      ],
    });
    assert.deepEqual(additionalRootsOf(record), ["/repos/main", "/repos/lib"]);
    assert.deepEqual(orderedRootsOf(record), ["/repos/primary", "/repos/main", "/repos/lib"]);
  });

  it("空 roots 时 orderedRootsOf 返回 null", () => {
    assert.equal(orderedRootsOf(project({ roots: [] })), null);
    assert.equal(orderedRootsOf(null), null);
  });
});

describe("resolveProjectForWorkspacePath", () => {
  const alpha = project({ projectId: "proj_a", roots: [{ rootPath: "/repos/alpha", position: 0, isPrimary: true }] });
  const beta = project({ projectId: "proj_b", roots: [{ rootPath: "/repos/alpha", position: 0, isPrimary: true }] });
  const pinnedBeta = { ...beta, pinned: true };
  const gamma = project({ projectId: "proj_c", roots: [{ rootPath: "/repos/gamma", position: 0, isPrimary: true }] });

  it("按 primary root 匹配唯一项目", () => {
    assert.equal(resolveProjectForWorkspacePath([alpha, gamma], "/repos/alpha"), alpha);
    assert.equal(resolveProjectForWorkspacePath([alpha, gamma], "/repos/missing"), null);
    assert.equal(resolveProjectForWorkspacePath([], "/repos/alpha"), null);
  });

  it("同 cwd 双项目：pinned 优先，其次 projectId 字典序（确定性）", () => {
    assert.equal(resolveProjectForWorkspacePath([alpha, pinnedBeta], "/repos/alpha"), pinnedBeta);
    assert.equal(resolveProjectForWorkspacePath([beta, alpha], "/repos/alpha"), alpha);
    assert.equal(resolveProjectForWorkspacePath([alpha, beta], "/repos/alpha"), alpha);
  });

  it("空白 workspacePath 不匹配", () => {
    assert.equal(resolveProjectForWorkspacePath([alpha], "   "), null);
  });
});

describe("projectDisplayName / leafNameOf / rootsBadgeCount", () => {
  it("显示名优先 name，缺省回落 defaultName 与路径 leaf", () => {
    assert.equal(projectDisplayName(project({ name: "Alpha", defaultName: "alpha" })), "Alpha");
    assert.equal(projectDisplayName(project({ name: "", defaultName: "alpha" })), "alpha");
    assert.equal(
      projectDisplayName(project({ name: "", defaultName: null })),
      "alpha",
    );
  });

  it("leafNameOf 兼容两种分隔符与尾斜线", () => {
    assert.equal(leafNameOf("/repos/alpha"), "alpha");
    assert.equal(leafNameOf("C:\\repos\\alpha\\"), "alpha");
    assert.equal(leafNameOf("/"), "/");
  });

  it("roots 徽标只对多 root 项目给出计数", () => {
    const single = project({});
    assert.equal(projectRootsBadgeCount(single), null);
    const multi = project({
      roots: [
        { rootPath: "/repos/a", position: 0, isPrimary: true },
        { rootPath: "/repos/b", position: 1, isPrimary: false },
      ],
    });
    assert.equal(projectRootsBadgeCount(multi), 2);
  });
});
