import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import type { ZCodeTaskMeta } from "@zcode/shared";

/** 多目录项目 P1b-2：任务行项目三件套的固化与快照保全（docs/specs/multi-root-projects.md）。 */
function projectTaskMeta(overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  const now = Date.now();
  return {
    taskId: "sess_reserve_1",
    traceId: "zcode-sess_reserve_1",
    title: "项目任务",
    workspacePath: "D:/code/datacenter",
    createdAt: now,
    updatedAt: now,
    mode: "build",
    projectId: "proj_1",
    rootPath: "D:/code/datacenter",
    executionDirectories: ["D:/docs/bbdx"],
    ...overrides,
  };
}

describe("task index 项目归属三件套", () => {
  let workspace: string;
  let repo: TaskIndexRepo;

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "project-reserve-"));
    repo = new TaskIndexRepo(join(workspace, "tasks.sqlite"));
  });

  after(async () => {
    repo.close();
    await rm(workspace, { recursive: true, force: true });
  });

  it("reserve 写入后可完整读回（列 + meta_json 双投影）", async () => {
    await repo.syncTaskMeta({ meta: projectTaskMeta() });
    const read = await repo.getTaskMeta({
      workspacePath: "D:/code/datacenter",
      taskId: "sess_reserve_1",
    });
    assert.equal(read?.projectId, "proj_1");
    assert.equal(read?.rootPath, "D:/code/datacenter");
    assert.deepEqual(read?.executionDirectories, ["D:/docs/bbdx"]);
  });

  it("运行态快照同步不带项目字段时，既有归属不被冲掉", async () => {
    const snapshotLike = projectTaskMeta({
      // 模拟后续 protocol snapshot：不带 projectId/rootPath/executionDirectories。
      projectId: undefined,
      rootPath: undefined,
      executionDirectories: undefined,
      updatedAt: Date.now() + 1000,
      title: "项目任务（运行中）",
    });
    await repo.syncTaskMeta({ meta: snapshotLike });
    const read = await repo.getTaskMeta({
      workspacePath: "D:/code/datacenter",
      taskId: "sess_reserve_1",
    });
    assert.equal(read?.projectId, "proj_1");
    assert.equal(read?.rootPath, "D:/code/datacenter");
    assert.deepEqual(read?.executionDirectories, ["D:/docs/bbdx"]);
    // 快照带来的其它更新正常生效。
    assert.equal(read?.title, "项目任务（运行中）");
  });

  it("非项目任务零影响：不写三列，读写不带字段", async () => {
    const meta = projectTaskMeta({
      taskId: "sess_plain",
      traceId: "zcode-sess_plain",
      projectId: undefined,
      rootPath: undefined,
      executionDirectories: undefined,
    });
    await repo.syncTaskMeta({ meta });
    const read = await repo.getTaskMeta({
      workspacePath: "D:/code/datacenter",
      taskId: "sess_plain",
    });
    assert.equal(read?.projectId, undefined);
    assert.equal(read?.rootPath, undefined);
    assert.equal(read?.executionDirectories, undefined);
  });
});
