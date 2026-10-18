import assert from "node:assert/strict";
import test from "node:test";
import { resolveZCodeAgentPresentationSurface } from "../src/zcode-agent/zcodeAgentPresentationSurface.js";

// presentation surface 是呈现宿主的结构性事实（26.2.0 起）：不再被 desktop-context-prompt
// 灰度门禁——那个灰度在审计版构建恒为本地关闭态，曾让 zcode_desktop 永不成立、
// gen-ui P1 的上下文注入与输出目录派生在打包版整体失效。

test("desktop local host resolves to desktop surface", () => {
  assert.equal(
    resolveZCodeAgentPresentationSurface({ runtimeSurface: "desktop_local_host" }),
    "desktop",
  );
});

test("desktop-attached remote workspace resolves to desktop surface", () => {
  assert.equal(
    resolveZCodeAgentPresentationSurface({ serviceAuthorityMode: "desktop-attached-remote" }),
    "desktop",
  );
});

test("remote workspace host without desktop attachment stays terminal", () => {
  assert.equal(
    resolveZCodeAgentPresentationSurface({ runtimeSurface: "remote_workspace_host" }),
    undefined,
  );
});

test("facts-less invocations (HTTP/manual app-server) stay terminal", () => {
  assert.equal(resolveZCodeAgentPresentationSurface({}), undefined);
});
