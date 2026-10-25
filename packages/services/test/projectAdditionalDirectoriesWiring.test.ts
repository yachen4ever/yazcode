import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ZCODE_PROTOCOL_NAME,
  ZCODE_PROTOCOL_VERSION,
  zcodeSessionStateSnapshotSchema,
  type ZCodeSessionStateSnapshot,
  type ZCodeTaskMeta,
} from "@zcode/shared";
import { setDataBaseDir } from "../src/paths.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { createZCodeTaskServiceAdapter } from "../src/zcode-agent/zcodeTaskServiceAdapter.js";

/**
 * P2 adapter 接线（docs/specs/multi-root-projects.md「协议三通道（P2）」）：
 * - createTask 的 session create 载荷下发附加目录（与 cwd 覆写同一 prepareSession 来源）；
 * - 恢复/冷恢复路径经 resolveSessionDirectories（任务行固化值优先）重解析后下发；
 * - L1 空数组语义：固化的「显式空」必须原样传给解析器，不得折叠成无固化值。
 */

const WORKSPACE_PATH = "D:/code/datacenter";
const SECONDARY = "D:/docs/bbdx";

function projectTaskMeta(overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  const now = Date.now();
  return {
    taskId: "sess_p2_wire",
    traceId: "zcode-sess_p2_wire",
    title: "项目任务",
    workspacePath: WORKSPACE_PATH,
    createdAt: now,
    updatedAt: now,
    mode: "build",
    projectId: "proj_p2",
    rootPath: WORKSPACE_PATH,
    executionDirectories: [SECONDARY],
    ...overrides,
  };
}

function snapshotFor(input: { sessionId: string; workspacePath: string }): ZCodeSessionStateSnapshot {
  return zcodeSessionStateSnapshotSchema.parse({
    protocol: { name: ZCODE_PROTOCOL_NAME, version: ZCODE_PROTOCOL_VERSION },
    session: {
      sessionId: input.sessionId,
      workspace: {
        workspacePath: input.workspacePath,
        workspaceKey: input.workspacePath,
      },
      sessionKind: "interactive",
      title: "P2 会话",
      mode: "build",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    },
    settings: {
      model: { available: [] },
      thoughtLevel: { enabled: false, available: [] },
      mode: { current: "build" },
    },
    projection: {
      sessionId: input.sessionId,
      status: "idle",
      mode: "build",
      turnCount: 0,
      totalTokenCount: 0,
      contextUsed: 0,
      contextWindow: 200000,
      pendingPermissions: [],
      activeToolCalls: [],
      backgroundJobs: [],
    },
    runtime: { eventSeq: 0, stateRevision: 0, pendingRequestIds: [] },
    messages: [],
  });
}

describe("多目录项目 P2 adapter 接线", () => {
  let dir: string;
  let repo: TaskIndexRepo;
  type Options = Parameters<typeof createZCodeTaskServiceAdapter>[0];

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "p2-additional-dirs-"));
    setDataBaseDir(dir);
    repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  });

  after(async () => {
    repo.close();
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  });

  function buildAdapter(input: {
    zcodeAgentService: Partial<Options["zcodeAgentService"]>;
    projectService?: Options["projectService"];
  }) {
    const disposable = () => ({ dispose() {} });
    return createZCodeTaskServiceAdapter({
      taskIndexRepo: repo,
      zcodeAgentService: {
        disposeAll() {},
        ...input.zcodeAgentService,
      } as unknown as Options["zcodeAgentService"],
      taskIndexSyncer: {
        onSessionTerminalEvent: disposable,
        onSessionReadyEvent: disposable,
        onDynamicWorkspaceEvent: disposable,
        getWorkspaceEmitter: () => ({ fire() {}, emit() {}, dispose() {} }),
        ensureSessionSubscription() {},
        emitWorkspaceTaskListChanged() {},
        disposeAll() {},
      } as unknown as Options["taskIndexSyncer"],
      projectService: input.projectService,
    });
  }

  it("createTask：session create 载荷下发 prepareSession 的附加目录，且 reserve 固化不变", async () => {
    const created: Array<{ additionalDirectories?: string[]; workspacePath: string }> = [];
    const service = buildAdapter({
      zcodeAgentService: {
        async createSession(input: Parameters<Options["zcodeAgentService"]["createSession"]>[0]) {
          created.push(input as { additionalDirectories?: string[]; workspacePath: string });
          return snapshotFor({
            sessionId: input.sessionId ?? "sess_created",
            workspacePath: input.workspacePath,
          });
        },
      },
      projectService: {
        async prepareSession() {
          return {
            projectId: "proj_p2",
            workspacePath: WORKSPACE_PATH,
            additionalDirectories: [SECONDARY, "D:/notes"],
          };
        },
      },
    });
    try {
      await service.createTask({ projectId: "proj_p2" } as never);
      assert.equal(created.length, 1);
      // cwd 覆写与附加目录同一来源（prepareSession）。
      assert.equal(created[0]?.workspacePath, WORKSPACE_PATH);
      assert.deepEqual(created[0]?.additionalDirectories, [SECONDARY, "D:/notes"]);
      const read = await repo.getTaskMeta({ workspacePath: WORKSPACE_PATH, taskId: "sess_created" });
      assert.deepEqual(read?.executionDirectories, [SECONDARY, "D:/notes"]);
    } finally {
      service.disposeAll();
    }
  });

  it("resumeTask：经 resolveSessionDirectories 重解析（任务行固化值优先）并随 resume 下发", async () => {
    await repo.syncTaskMeta({ meta: projectTaskMeta() });
    const resolverInputs: Array<{
      projectId: string;
      taskWorkspacePath?: string;
      taskExecutionDirectories?: string | readonly string[] | null;
    }> = [];
    const resumed: Array<{ additionalDirectories?: string[] }> = [];
    const service = buildAdapter({
      zcodeAgentService: {
        async resumeSession(input: Parameters<Options["zcodeAgentService"]["resumeSession"]>[0]) {
          resumed.push(input);
          return snapshotFor({
            sessionId: input.sessionId,
            workspacePath: input.workspacePath,
          });
        },
      },
      projectService: {
        async prepareSession() {
          throw new Error("resume 路径不得调用 prepareSession");
        },
        async resolveSessionDirectories(resolverInput) {
          resolverInputs.push({ ...resolverInput });
          return {
            projectId: resolverInput.projectId,
            workspacePath: WORKSPACE_PATH,
            additionalDirectories: [SECONDARY],
            fromTaskRecord: true,
          };
        },
      },
    });
    try {
      await service.resumeTask({
        taskId: "sess_p2_wire",
        workspacePath: WORKSPACE_PATH,
      } as never);
      assert.equal(resolverInputs.length, 1);
      assert.equal(resolverInputs[0]?.projectId, "proj_p2");
      assert.equal(resolverInputs[0]?.taskWorkspacePath, WORKSPACE_PATH);
      // 固化值原样传入（数组形态，非原始 JSON）。
      assert.deepEqual(resolverInputs[0]?.taskExecutionDirectories, [SECONDARY]);
      assert.deepEqual(resumed[0]?.additionalDirectories, [SECONDARY]);
    } finally {
      service.disposeAll();
    }
  });

  it("L1：单 root 项目固化的空数组原样传给解析器（显式空 ≠ 无固化值），空结果不写字段", async () => {
    await repo.syncTaskMeta({
      meta: projectTaskMeta({
        taskId: "sess_p2_empty",
        traceId: "zcode-sess_p2_empty",
        executionDirectories: [],
      }),
    });
    const resolverInputs: Array<{
      taskExecutionDirectories?: string | readonly string[] | null;
    }> = [];
    const resumed: Array<{ additionalDirectories?: string[] }> = [];
    const service = buildAdapter({
      zcodeAgentService: {
        async resumeSession(input: Parameters<Options["zcodeAgentService"]["resumeSession"]>[0]) {
          resumed.push(input);
          return snapshotFor({
            sessionId: input.sessionId,
            workspacePath: input.workspacePath,
          });
        },
      },
      projectService: {
        async prepareSession() {
          throw new Error("resume 路径不得调用 prepareSession");
        },
        async resolveSessionDirectories(resolverInput) {
          resolverInputs.push({ ...resolverInput });
          return {
            projectId: String(resolverInput.projectId),
            workspacePath: WORKSPACE_PATH,
            additionalDirectories: [],
            fromTaskRecord: true,
          };
        },
      },
    });
    try {
      await service.resumeTask({
        taskId: "sess_p2_empty",
        workspacePath: WORKSPACE_PATH,
      } as never);
      // 关键断言：空数组必须原样到达解析器；若被 ?? 折叠成 null，
      // 解析器会回落项目当前 roots（改项目 roots 影响旧任务，违反数据契约）。
      assert.equal(resolverInputs.length, 1);
      assert.deepEqual(resolverInputs[0]?.taskExecutionDirectories, []);
      // 空结果不下发字段（缺席 = 单目录会话）。
      assert.equal(resumed[0]?.additionalDirectories, undefined);
    } finally {
      service.disposeAll();
    }
  });

  it("未装配 ProjectService 时恢复路径降级为不下发附加目录（不阻塞恢复）", async () => {
    await repo.syncTaskMeta({ meta: projectTaskMeta({ taskId: "sess_p2_nosvc" }) });
    const resumed: Array<{ additionalDirectories?: string[] }> = [];
    const service = buildAdapter({
      zcodeAgentService: {
        async resumeSession(input: Parameters<Options["zcodeAgentService"]["resumeSession"]>[0]) {
          resumed.push(input);
          return snapshotFor({
            sessionId: input.sessionId,
            workspacePath: input.workspacePath,
          });
        },
      },
    });
    try {
      await service.resumeTask({
        taskId: "sess_p2_nosvc",
        workspacePath: WORKSPACE_PATH,
      } as never);
      assert.equal(resumed.length, 1);
      assert.equal(resumed[0]?.additionalDirectories, undefined);
    } finally {
      service.disposeAll();
    }
  });
});
