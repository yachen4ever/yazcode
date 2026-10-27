import assert from "node:assert/strict";
import { test } from "node:test";
import { commandPayloadSchemas } from "@zcode/shared/zcode-protocol-v4";
import { createSessionProjectContextRegistry } from "../src/zcode-agent/sessionProjectContext.js";

// G1（docs/specs/multi-root-projects.md）：桌面 v4 草稿首发的项目归属——
// 登记表按 workspaceKey 取即清；projectContext 不进 wire envelope（strict schema 拒绝）。

test("登记表：register 后 consume 取得并清除，未登记键返回 undefined", () => {
  const registry = createSessionProjectContextRegistry();
  registry.register("ws-a", {
    projectId: "proj_1",
    rootPath: "/repo",
    executionDirectories: ["/extra"],
  });
  assert.deepEqual(registry.consume("ws-a"), {
    projectId: "proj_1",
    rootPath: "/repo",
    executionDirectories: ["/extra"],
  });
  // 取即清：同键二次 consume 不复得（防旧值复用错盖章）。
  assert.equal(registry.consume("ws-a"), undefined);
  assert.equal(registry.consume("ws-b"), undefined);
});

test("登记表：同 workspaceKey 重复 register 以最后一次为准", () => {
  const registry = createSessionProjectContextRegistry();
  registry.register("ws-a", { projectId: "proj_old", rootPath: "/old", executionDirectories: [] });
  registry.register("ws-a", { projectId: "proj_new", rootPath: "/new", executionDirectories: [] });
  assert.equal(registry.consume("ws-a")?.projectId, "proj_new");
});

test("wire 不变性：createSession payload schema 不含 projectContext 字段", () => {
  // createSession payload schema 非 strict（上游 wire 惯例），「不进 wire」的约束由
  // 类型与构建路径保证（projectContext 仅存在于命令 params 与宿主登记表）；
  // schema 形状断言锚定 payload 面不含该字段，防止日后被改道进 wire。
  const base = { workspaceId: "ws_g1" };
  assert.deepEqual(commandPayloadSchemas.createSession.parse(base), base);
  assert.equal("projectContext" in commandPayloadSchemas.createSession.shape, false);
});
