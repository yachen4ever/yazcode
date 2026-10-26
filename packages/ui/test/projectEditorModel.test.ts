import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProjectRecord } from "@zcode/services";
import {
  addRootsToForm,
  buildProjectSaveInput,
  createProjectEditorForm,
  projectEditorDisplayName,
  projectEditorErrorKey,
  removeRootFromForm,
  setPrimaryRootInForm,
  renameProjectInForm,
} from "../src/project-editor/projectEditorModel.js";

/** 项目编辑器表单模型纯迁移（docs/specs/multi-root-projects.md「P3b 项目编辑器」）。 */

function record(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    projectId: "proj_a",
    hostId: "local",
    name: "Alpha",
    defaultName: null,
    pinned: false,
    roots: [
      { rootPath: "/repos/alpha", position: 0, isPrimary: true },
      { rootPath: "/repos/lib", position: 1, isPrimary: false },
    ],
    ...overrides,
  };
}

describe("createProjectEditorForm", () => {
  it("编辑态取项目名与主目录；新建态取初始 roots 首个为主目录", () => {
    const editing = createProjectEditorForm(record());
    assert.equal(editing.name, "Alpha");
    assert.equal(editing.primaryRoot, "/repos/alpha");
    assert.equal(editing.nameEdited, false);

    const creating = createProjectEditorForm(null, ["/repos/x", "/repos/x", "  ", ""]);
    assert.deepEqual(creating.roots, ["/repos/x"]);
    assert.equal(creating.primaryRoot, "/repos/x");
    assert.equal(creating.name, "");
  });
});

describe("addRootsToForm", () => {
  it("去重保序、滤空；首个 root 自动成为主目录", () => {
    const form = createProjectEditorForm(null);
    const withRoots = addRootsToForm(form, ["/repos/a", "/repos/a", " /repos/b ", ""]);
    assert.deepEqual(withRoots.roots, ["/repos/a", "/repos/b"]);
    assert.equal(withRoots.primaryRoot, "/repos/a");
  });

  it("已有主目录时不改写主目录；全空输入原样返回", () => {
    const form = createProjectEditorForm(record());
    const added = addRootsToForm(form, ["/repos/new"]);
    assert.equal(added.primaryRoot, "/repos/alpha");
    assert.deepEqual(added.roots, ["/repos/alpha", "/repos/lib", "/repos/new"]);

    assert.equal(addRootsToForm(form, ["", "   "]), form);
  });
});

describe("removeRootFromForm", () => {
  it("移除主目录时回落首个 root（spec：主目录被移除时回落首个 root）", () => {
    const removed = removeRootFromForm(createProjectEditorForm(record()), "/repos/alpha");
    assert.deepEqual(removed.roots, ["/repos/lib"]);
    assert.equal(removed.primaryRoot, "/repos/lib");
  });

  it("移除非主目录时主目录不变；roots 清空后主目录为空", () => {
    const kept = removeRootFromForm(createProjectEditorForm(record()), "/repos/lib");
    assert.equal(kept.primaryRoot, "/repos/alpha");
    const emptied = removeRootFromForm(
      createProjectEditorForm(null, ["/repos/only"]),
      "/repos/only",
    );
    assert.deepEqual(emptied.roots, []);
    assert.equal(emptied.primaryRoot, "");
  });
});

describe("setPrimaryRootInForm / renameProjectInForm", () => {
  it("主目录切换限定在 roots 内；改名标记 nameEdited", () => {
    const form = createProjectEditorForm(record());
    assert.equal(setPrimaryRootInForm(form, "/repos/missing"), form);
    assert.equal(setPrimaryRootInForm(form, "/repos/lib").primaryRoot, "/repos/lib");
    const renamed = renameProjectInForm(form, "New");
    assert.equal(renamed.name, "New");
    assert.equal(renamed.nameEdited, true);
  });
});

describe("buildProjectSaveInput", () => {
  it("roots 空返回 null；未改名沿用主目录 leaf 作为 name；主目录缺省走首个 root", () => {
    assert.equal(buildProjectSaveInput(createProjectEditorForm(null)), null);
    const unnamed = buildProjectSaveInput(createProjectEditorForm(null, ["/repos/a"]));
    assert.deepEqual(unnamed, { name: "a", roots: ["/repos/a"], primaryRoot: "/repos/a" });

    const renamed = buildProjectSaveInput(
      renameProjectInForm(createProjectEditorForm(record()), "  Renamed  "),
      { projectId: record().projectId },
    );
    assert.deepEqual(renamed, {
      projectId: "proj_a",
      name: "Renamed",
      roots: ["/repos/alpha", "/repos/lib"],
      primaryRoot: "/repos/alpha",
    });

    const editing = buildProjectSaveInput(
      setPrimaryRootInForm(createProjectEditorForm(record()), "/repos/lib"),
    );
    assert.equal(editing?.primaryRoot, "/repos/lib");
    // 未改名时 name 沿用展示名（服务契约 name 必填；同名写回是幂等 no-op）。
    assert.equal(editing?.name, "Alpha");
  });
});

describe("projectEditorDisplayName / projectEditorErrorKey", () => {
  it("展示名优先显式改名，否则回落主目录 leaf", () => {
    assert.equal(projectEditorDisplayName(createProjectEditorForm(record())), "Alpha");
    assert.equal(
      projectEditorDisplayName(createProjectEditorForm(null, ["/repos/alpha"])),
      "alpha",
    );
  });

  it("服务错误码映射 i18n 键，未知回落通用失败", () => {
    assert.equal(projectEditorErrorKey(new Error("project.roots-empty")), "projectEditor.error.rootsEmpty");
    assert.equal(
      projectEditorErrorKey(new Error("project.primary-root-missing: /repos/alpha")),
      "projectEditor.error.primaryRootMissing",
    );
    assert.equal(projectEditorErrorKey(new Error("boom")), "projectEditor.error.saveFailed");
  });
});
