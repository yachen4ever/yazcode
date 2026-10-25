import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectRepository } from "../src/session/projectRepository.js";
import { createProjectService } from "../src/project/projectService.js";

/** 多目录项目 P1b 服务层（docs/specs/multi-root-projects.md 会话契约）。 */
describe("IProjectService", () => {
  let workspace: string;
  let primaryRoot: string;
  let service: ReturnType<typeof createProjectService>;

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "projects-p1b-"));
    primaryRoot = join(workspace, "primary");
    await mkdir(primaryRoot);
    const repo = new ProjectRepository(join(workspace, "tasks-index.sqlite"));
    service = createProjectService(repo);
    await service.saveProject({
      name: "multi",
      roots: [primaryRoot, join(workspace, "secondary"), join(workspace, "tertiary")],
      primaryRoot,
    });
  });

  after(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("prepareSession：cwd=primary、附加目录=其余 roots 且排除 primary", async () => {
    const prepared = await service.prepareSession({
      projectId: (await service.listProjects()).find((p) => p.name === "multi")!.projectId,
    });
    assert.equal(prepared.workspacePath, primaryRoot);
    assert.deepEqual(prepared.additionalDirectories, [
      join(workspace, "secondary"),
      join(workspace, "tertiary"),
    ]);
  });

  it("prepareSession：primary 在文件系统上缺失即拒绝，不 mkdir 复活", async () => {
    const missing = join(workspace, "gone");
    const saved = await service.saveProject({ name: "missing", roots: [missing] });
    await assert.rejects(
      () => service.prepareSession({ projectId: saved.projectId }),
      /project.primary-root-missing/,
    );
    await assert.rejects(() => stat(missing), undefined, "不得创建目录");
  });

  it("resolveSessionDirectories：任务固化值优先（fromTaskRecord=true）", async () => {
    const saved = await service.saveProject({
      name: "resolve",
      roots: [primaryRoot, join(workspace, "secondary")],
    });
    const resolved = await service.resolveSessionDirectories({
      projectId: saved.projectId,
      taskWorkspacePath: primaryRoot,
      taskExecutionDirectories: JSON.stringify([join(workspace, "legacy-extra")]),
    });
    assert.equal(resolved.fromTaskRecord, true);
    assert.deepEqual(resolved.additionalDirectories, [join(workspace, "legacy-extra")]);
  });

  it("resolveSessionDirectories：无固化值按项目当前 roots 现算", async () => {
    const saved = await service.saveProject({
      name: "resolve-fresh",
      roots: [primaryRoot, join(workspace, "secondary")],
    });
    const resolved = await service.resolveSessionDirectories({ projectId: saved.projectId });
    assert.equal(resolved.fromTaskRecord, false);
    assert.equal(resolved.workspacePath, primaryRoot);
    assert.deepEqual(resolved.additionalDirectories, [join(workspace, "secondary")]);
  });
});
