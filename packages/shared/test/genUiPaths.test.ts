import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import {
  GEN_UI_OUTPUT_DIRECTORY,
  GEN_UI_OUTPUT_ROOT_ENV,
  getGenUiOutputDirectory,
} from "../src/node/genUiPaths.js";

// 路径必须用 node:path 构造当前平台的绝对路径：写死盘符会让本文件在非 Windows
// 机器上因 path.isAbsolute 判定失败而红（isAbsolute 对 "C:\..." 在 POSIX 上为 false）。
const root = path.resolve(path.sep, "users", "u", "visualizations-root");
const ws = path.resolve(path.sep, "ws");

describe("getGenUiOutputDirectory", () => {
  it("同 scope 派生稳定，session/identity 变化改变子目录", () => {
    const a = getGenUiOutputDirectory(root, {
      workspacePath: ws,
      sessionId: "s1",
    });
    assert.equal(a, getGenUiOutputDirectory(root, { workspacePath: ws, sessionId: "s1" }));
    assert.notEqual(
      a,
      getGenUiOutputDirectory(root, { workspacePath: ws, sessionId: "s2" }),
    );
    assert.notEqual(
      a,
      getGenUiOutputDirectory(root, {
        workspacePath: ws,
        workspaceIdentity: "remote-1",
        sessionId: "s1",
      }),
    );
  });

  it("子目录落在输出根下且为单层 sha256 名", () => {
    const dir = getGenUiOutputDirectory(root, { workspacePath: ws, sessionId: "s1" });
    assert.ok(dir.startsWith(root));
    const tail = dir.slice(root.length + 1);
    assert.match(tail, /^[0-9a-f]{64}$/);
  });

  it("输出根位于工作区内/等于工作区都是合法姿态（目录由 Host 决定）", () => {
    assert.doesNotThrow(() =>
      getGenUiOutputDirectory(path.join(ws, "visualizations-root"), {
        workspacePath: ws,
        sessionId: "s1",
      }),
    );
    assert.doesNotThrow(() =>
      getGenUiOutputDirectory(ws, { workspacePath: ws, sessionId: "s1" }),
    );
  });

  it("根或工作区非绝对路径直接抛错", () => {
    assert.throws(() =>
      getGenUiOutputDirectory("relative/root", { workspacePath: ws, sessionId: "s1" }),
    );
    assert.throws(() =>
      getGenUiOutputDirectory(root, { workspacePath: "ws", sessionId: "s1" }),
    );
  });

  it("常量与导出名稳定", () => {
    assert.equal(GEN_UI_OUTPUT_DIRECTORY, "visualizations");
    assert.equal(GEN_UI_OUTPUT_ROOT_ENV, "ZCODE_GEN_UI_OUTPUT_ROOT");
  });
});
