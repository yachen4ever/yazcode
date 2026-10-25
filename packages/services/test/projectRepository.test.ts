import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectRepository } from "../src/session/projectRepository.js";

/** 多目录项目 P1 数据层（docs/specs/multi-root-projects.md 验收 6/7 的数据面）。 */
describe("ProjectRepository", () => {
  let workspace: string;
  let repo: ProjectRepository;

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "projects-p1-"));
    repo = new ProjectRepository(join(workspace, "tasks-index.sqlite"));
    await repo.ensureReady();
  });

  after(async () => {
    repo.close();
    await rm(workspace, { recursive: true, force: true });
  });

  it("保存双 root 项目：指定主目录落位、position 有序、去重保序", () => {
    const saved = repo.saveProject({
      name: "datacenter",
      roots: ["D:/code/datacenter", "D:/docs/bbdx", "D:/code/datacenter"],
      primaryRoot: "D:/docs/bbdx",
    });
    assert.equal(saved.roots.length, 2);
    assert.deepEqual(
      saved.roots.map((root) => [root.rootPath, root.isPrimary]),
      [
        ["D:/code/datacenter", false],
        ["D:/docs/bbdx", true],
      ],
    );
    assert.deepEqual(
      saved.roots.map((root) => root.position),
      [0, 1],
    );
  });

  it("主目录缺省取首个 root；空 roots 与不在 roots 中的主目录都拒绝", () => {
    const saved = repo.saveProject({ name: "solo", roots: ["D:/solo"] });
    assert.equal(saved.roots[0]?.isPrimary, true);
    assert.throws(() => repo.saveProject({ name: "empty", roots: [] }), /project.roots-empty/);
    assert.throws(
      () => repo.saveProject({ name: "bad", roots: ["D:/a"], primaryRoot: "D:/b" }),
      /project.primary-not-in-roots/,
    );
  });

  it("重保存换主目录：primary 恒好一个，旧任务不受影响的数据前提成立", () => {
    const first = repo.saveProject({ name: "swap", roots: ["D:/one", "D:/two"] });
    const second = repo.saveProject({
      projectId: first.projectId,
      name: "swap",
      roots: ["D:/two", "D:/one", "D:/three"],
      primaryRoot: "D:/three",
    });
    assert.equal(second.projectId, first.projectId);
    const primaries = second.roots.filter((root) => root.isPrimary);
    assert.equal(primaries.length, 1);
    assert.equal(primaries[0]?.rootPath, "D:/three");
    assert.equal(repo.primaryRootOf(first.projectId), "D:/three");
  });

  it("删除项目级联清理 roots", () => {
    const saved = repo.saveProject({ name: "temp", roots: ["D:/temp"] });
    repo.deleteProject(saved.projectId);
    assert.throws(() => repo.getProject(saved.projectId), /project.not-found/);
  });

  it("adoptRecentProjects 幂等：首跑建单 root 项目，重跑零新增", () => {
    const firstRun = repo.adoptRecentProjects(["D:/code/newapi", "D:/Work", "D:/code/newapi"]);
    assert.equal(firstRun, 2);
    const secondRun = repo.adoptRecentProjects(["D:/code/newapi", "D:/Work"]);
    assert.equal(secondRun, 0);
    const adopted = repo
      .listProjects()
      .filter((project) => project.roots[0]?.rootPath === "D:/code/newapi");
    assert.equal(adopted.length, 1);
    assert.equal(adopted[0]?.roots[0]?.isPrimary, true);
  });
});
