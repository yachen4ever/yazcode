import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildGenUiScopeKey,
  genUiPathSchema,
  genUiReferenceSchema,
  genUiScopeSchema,
} from "../src/gen-ui/index.js";

describe("genUiPathSchema", () => {
  it("接受 unix 与 windows 绝对路径的小写连字符 html 文件", () => {
    assert.equal(genUiPathSchema.safeParse("/tmp/session-dir/demo.html").success, true);
    assert.equal(
      genUiPathSchema.safeParse("C:\\Users\\u\\visualizations\\ab\\my-chart-2.html").success,
      true,
    );
    assert.equal(genUiPathSchema.safeParse("\\\\srv\\share\\demo.html").success, true);
  });

  it("拒绝相对路径、.. 段、非法文件名与控制字符", () => {
    assert.equal(genUiPathSchema.safeParse("relative/demo.html").success, false);
    assert.equal(genUiPathSchema.safeParse("/a/../b/demo.html").success, false);
    assert.equal(genUiPathSchema.safeParse("/a/b/Demo.html").success, false);
    assert.equal(genUiPathSchema.safeParse("/a/b/demo.htm").success, false);
    assert.equal(genUiPathSchema.safeParse("/a/b/demo.html.exe").success, false);
    assert.equal(genUiPathSchema.safeParse("/a/b/de\u0000mo.html").success, false);
    assert.equal(genUiPathSchema.safeParse("/a/b/de\nmo.html").success, false);
    assert.equal(genUiPathSchema.safeParse("x".repeat(4097)).success, false);
  });
});

describe("genUiReferenceSchema", () => {
  it("title/mode 可选，mode 只认 wide，多余键拒绝", () => {
    const base = { path: "/s/demo.html" };
    assert.equal(genUiReferenceSchema.safeParse(base).success, true);
    assert.equal(
      genUiReferenceSchema.safeParse({ ...base, title: "Demo", mode: "wide" }).success,
      true,
    );
    assert.equal(genUiReferenceSchema.safeParse({ ...base, mode: "tall" }).success, false);
    assert.equal(genUiReferenceSchema.safeParse({ ...base, extra: 1 }).success, false);
  });
});

describe("buildGenUiScopeKey", () => {
  it("identity 优先，空白 identity 与无 identity 都回落路径", () => {
    const workspacePath = "D:\\ws";
    const byIdentity = buildGenUiScopeKey({
      workspacePath,
      workspaceIdentity: "  remote-1  ",
      sessionId: "s1",
    });
    assert.notEqual(
      byIdentity,
      buildGenUiScopeKey({ workspacePath, sessionId: "s1" }),
      "非空白 identity 必须与路径兜底区分开",
    );
    assert.equal(
      buildGenUiScopeKey({ workspacePath, workspaceIdentity: "   ", sessionId: "s1" }),
      buildGenUiScopeKey({ workspacePath, sessionId: "s1" }),
    );
    assert.equal(
      byIdentity,
      JSON.stringify(["remote-1", "s1"]),
      "键格式稳定，身份先行、会话在后",
    );
  });

  it("scope schema 是 strict：未知键拒绝", () => {
    assert.equal(genUiScopeSchema.safeParse({ workspacePath: "/w", sessionId: "s" }).success, true);
    assert.equal(
      genUiScopeSchema.safeParse({ workspacePath: "/w", sessionId: "s", o: 1 }).success,
      false,
    );
  });
});
