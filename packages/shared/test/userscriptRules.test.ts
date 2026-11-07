import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compileMatchPattern,
  explainMatchPatternProblem,
  parseUserScriptHeader,
  validateUserscriptHeaderDraft,
} from "../src/userscriptRules.js";

/**
 * 26.5.4 S2：@match 诊断与草稿校验。硬约束：explain 与 compile 同序同步——
 * 「explain 说没问题 ⇔ compile 会通过」，两侧分支漂移会让输入时提示与扫描结果打架。
 */

describe("explainMatchPatternProblem 与 compileMatchPattern 同步", () => {
  const legal = [
    "https://example.com/*",
    "http://localhost/*",
    "*://*.example.com/path*",
    "<all_urls>",
    "*://*/*",
    "https://oa.corp.internal/",
  ];
  const illegal = [
    "http://localhost:8899/*",
    "https://[::1]:8443/*",
    "ftp://example.com/*",
    "example.com/*",
    "https://exa*mple.com/*",
    "https://*bad.test/*",
  ];

  for (const pattern of legal) {
    it(`合法 pattern 无诊断：${pattern}`, () => {
      assert.equal(explainMatchPatternProblem(pattern), null);
      assert.ok(compileMatchPattern(pattern));
    });
  }

  for (const pattern of illegal) {
    it(`非法 pattern 有诊断：${pattern}`, () => {
      assert.ok(explainMatchPatternProblem(pattern));
      assert.equal(compileMatchPattern(pattern), null);
    });
  }

  it("混合集合同步性：explain===null ⇔ compile 通过", () => {
    for (const pattern of [...legal, ...illegal]) {
      assert.equal(
        explainMatchPatternProblem(pattern) === null,
        compileMatchPattern(pattern) !== null,
        pattern,
      );
    }
  });
});

describe("explainMatchPatternProblem 诊断分支", () => {
  it("端口 host 携带裸 host 改写建议", () => {
    const problem = explainMatchPatternProblem("http://localhost:8899/*");
    assert.equal(problem?.kind, "port_host");
    assert.ok(problem?.kind === "port_host" && problem.suggestion === "http://localhost/*");
  });

  it("IPv6 字面量端口建议剥到 ]", () => {
    const problem = explainMatchPatternProblem("https://[::1]:8443/*");
    assert.ok(problem?.kind === "port_host");
    assert.ok(problem?.kind === "port_host" && problem.suggestion === "https://[::1]/*");
  });

  it("path 通配超限给上限值；格式非法与坏通配各归各分支", () => {
    const tooMany = explainMatchPatternProblem("https://a.test/*/*/*/*/*/*/*/*/*");
    assert.ok(tooMany?.kind === "too_many_path_wildcards" && tooMany.limit === 8);
    assert.equal(explainMatchPatternProblem("ftp://a.test/*")?.kind, "invalid_format");
    assert.equal(explainMatchPatternProblem("https://exa*mple.com/*")?.kind, "bad_wildcard");
  });
});

describe("validateUserscriptHeaderDraft（编辑器草稿校验）", () => {
  it("合法草稿返回空数组", () => {
    const draft = [
      "// ==UserScript==",
      "// @name demo",
      "// @match http://localhost/*",
      "// ==/UserScript==",
      "void 0;",
    ].join("\n");
    assert.deepEqual(validateUserscriptHeaderDraft(draft), []);
  });

  it("缺元数据块 / 缺 @match / 端口 pattern 分别成问题", () => {
    assert.deepEqual(validateUserscriptHeaderDraft("void 0;"), [
      { kind: "metadata_missing" },
    ]);
    assert.deepEqual(validateUserscriptHeaderDraft("// ==UserScript==\n// ==/UserScript=="), [
      { kind: "match_missing" },
    ]);
    const problems = validateUserscriptHeaderDraft(
      "// ==UserScript==\n// @match http://localhost:3000/*\n// ==/UserScript==",
    );
    assert.equal(problems.length, 1);
    assert.equal(problems[0]?.kind, "pattern");
    assert.equal(problems[0]?.pattern, "http://localhost:3000/*");
  });

  it("多条 pattern 逐条诊断，合法条目不误报", () => {
    const problems = validateUserscriptHeaderDraft(
      [
        "// ==UserScript==",
        "// @match https://ok.test/*",
        "// @match http://localhost:8899/*",
        "// @match bad-pattern",
        "// ==/UserScript==",
      ].join("\n"),
    );
    assert.equal(problems.length, 2);
    assert.deepEqual(
      problems.map((problem) => (problem.kind === "pattern" ? problem.problem.kind : problem.kind)),
      ["port_host", "invalid_format"],
    );
  });

  it("header 解析行为与迁移前一致（回归锚）", () => {
    const header = parseUserScriptHeader(
      [
        "// ==UserScript==",
        "// @name 门户清理",
        "// @match https://oa.test/*",
        "// @run-at document-end",
        "// @grant GM_addStyle",
        "// ==/UserScript==",
      ].join("\n"),
    );
    assert.equal(header?.name, "门户清理");
    assert.deepEqual(header?.matchPatterns, ["https://oa.test/*"]);
    assert.equal(header?.runAt, "document-end");
    assert.deepEqual(header?.grants, ["GM_addStyle"]);
  });
});
