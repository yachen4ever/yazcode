import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildUserScriptDef,
  compileMatchPattern,
  isInjectableUrlProtocol,
  normalizeRunAt,
  parseUserScriptHeader,
  resolveUserScriptGrants,
  urlMatchesCompiledPattern,
} from "../src/main/userscripts/userscriptRules.js";

function urlOf(text: string): URL {
  return new URL(text);
}

function matches(patternText: string, urlText: string): boolean {
  const compiled = compileMatchPattern(patternText);
  if (!compiled) throw new Error(`pattern should compile: ${patternText}`);
  return urlMatchesCompiledPattern(urlOf(urlText), compiled);
}

describe("isInjectableUrlProtocol / normalizeRunAt", () => {
  it("仅 http(s) 可注入，chrome-error/about/devtools 全部 no-op", () => {
    assert.equal(isInjectableUrlProtocol("http:"), true);
    assert.equal(isInjectableUrlProtocol("https:"), true);
    for (const protocol of [
      "chrome-error:",
      "about:",
      "devtools:",
      "file:",
      "zcode-browser-restore:",
    ]) {
      assert.equal(isInjectableUrlProtocol(protocol), false, protocol);
    }
  });

  it("run-at 三档合法（大小写不敏感），未知值返回 null", () => {
    assert.equal(normalizeRunAt("document-start"), "document-start");
    assert.equal(normalizeRunAt("Document-End"), "document-end");
    assert.equal(normalizeRunAt(" document-idle "), "document-idle");
    assert.equal(normalizeRunAt("document-body"), null);
    assert.equal(normalizeRunAt(42), null);
  });
});

describe("parseUserScriptHeader", () => {
  const fullHeader = `
// ==UserScript==
// @name         门户面板隐藏
// @namespace    yazcode/workwin
// @version      1.2.0
// @match        https://oa.example.com/*
// @match        http://portal.example.com/*
// @run-at       document-end
// @grant        GM_addStyle
// @grant        GM_getValue
// ==/UserScript==
const real = "code";
`;

  it("解析完整元数据块", () => {
    const header = parseUserScriptHeader(fullHeader);
    assert.ok(header);
    assert.equal(header.name, "门户面板隐藏");
    assert.equal(header.version, "1.2.0");
    assert.deepEqual(header.matchPatterns, [
      "https://oa.example.com/*",
      "http://portal.example.com/*",
    ]);
    assert.equal(header.runAt, "document-end");
    assert.deepEqual(header.grants, ["GM_addStyle", "GM_getValue"]);
  });

  it("块缺失或起止不完整返回 null", () => {
    assert.equal(parseUserScriptHeader("const x = 1;"), null);
    assert.equal(parseUserScriptHeader("// ==UserScript==\n// @match https://a.test/*\n"), null);
  });

  it("重复 @name 取第一个；@match 空值忽略", () => {
    const header = parseUserScriptHeader(`
// ==UserScript==
// @name first
// @name second
// @match
// @match https://a.test/*
// ==/UserScript==`);
    assert.ok(header);
    assert.equal(header.name, "first");
    assert.deepEqual(header.matchPatterns, ["https://a.test/*"]);
  });
});

describe("compileMatchPattern / urlMatchesCompiledPattern", () => {
  it("scheme 通配 * 同时命中 http 与 https", () => {
    assert.equal(matches("*://oa.example.com/*", "https://oa.example.com/x"), true);
    assert.equal(matches("*://oa.example.com/*", "http://oa.example.com/x"), true);
    assert.equal(matches("*://oa.example.com/*", "ftp://oa.example.com/x"), false);
  });

  it("*.example.com 命中自身与子域；精确 host 不命中子域", () => {
    assert.equal(matches("https://*.example.com/", "https://example.com/"), true);
    assert.equal(matches("https://*.example.com/", "https://a.example.com/"), true);
    assert.equal(matches("https://*.example.com/", "https://a.b.example.com/"), true);
    assert.equal(matches("https://example.com/*", "https://sub.example.com/"), false);
    assert.equal(matches("https://example.com/*", "https://example.com/"), true);
  });

  it("path 通配跨 /；query 参与匹配", () => {
    assert.equal(matches("https://x.test/a*b", "https://x.test/a/zz/b"), true);
    assert.equal(matches("https://x.test/p*", "https://x.test/p?q=1"), true);
    assert.equal(matches("https://x.test/p", "https://x.test/p?q=1"), false);
  });

  it("URL 端口在匹配时被忽略（Chrome 语义）", () => {
    assert.equal(matches("http://x.test/a*", "http://x.test:8080/abc"), true);
  });

  it("path 段 * 数量超上限拒编译（m2-1 fail-closed），上限内正常通过", () => {
    // MAX_MATCH_PATTERN_PATH_WILDCARDS = 8：超限 pattern 回 main 进程多项式回溯，拒载。
    const overLimit = "https://x.test/" + "a*".repeat(9);
    assert.equal(compileMatchPattern(overLimit), null);
    // 恰好达到上限的 pattern 仍可用（正常 match pattern 只需 1-2 个通配）。
    const atLimit = "https://x.test/" + "a*".repeat(8);
    assert.ok(compileMatchPattern(atLimit));
    assert.ok(compileMatchPattern("https://x.test/*"));
  });

  it("非法 pattern 拒编译：缺 path、scheme 越界、host 内嵌星号、携带端口", () => {
    for (const bad of [
      "http://x.test",
      "ftp://x.test/*",
      "chrome://x/*",
      "http://*.x.*.com/*",
      "http://x.test:80/*",
      "not-a-pattern",
    ]) {
      assert.equal(compileMatchPattern(bad), null, bad);
    }
  });

  it("<all_urls> 限 http(s)，非 http(s) URL 永不命中", () => {
    assert.equal(matches("<all_urls>", "https://any.test/path?q=1"), true);
    assert.equal(matches("<all_urls>", "http://any.test/"), true);
    assert.equal(matches("<all_urls>", "chrome-error://chromewebdata/"), false);
    assert.equal(matches("<all_urls>", "about:blank"), false);
    assert.equal(matches("<all_urls>", "file:///tmp/x.html"), false);
  });
});

describe("resolveUserScriptGrants", () => {
  it("白名单 grant 通过并去重；none 视为空", () => {
    assert.deepEqual(
      resolveUserScriptGrants(["GM_addStyle", "GM_getValue", "GM_addStyle"]).grants,
      ["GM_addStyle", "GM_getValue"],
    );
    assert.deepEqual(resolveUserScriptGrants(["none"]).grants, []);
    assert.deepEqual(resolveUserScriptGrants([]).grants, []);
  });

  it("白名单之外的 grant 拒载（fail-closed）", () => {
    const result = resolveUserScriptGrants(["GM_addStyle", "GM_xmlhttpRequest"]);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /GM_xmlhttpRequest/);
  });

  it("空格/逗号分隔的多 token 单行也接受", () => {
    assert.deepEqual(resolveUserScriptGrants(["GM_addStyle GM_getValue,GM_setValue"]).grants, [
      "GM_addStyle",
      "GM_getValue",
      "GM_setValue",
    ]);
  });
});

describe("buildUserScriptDef", () => {
  it("缺省 run-at=document-start、grant=none；@name 缺省回退文件名 stem", () => {
    const result = buildUserScriptDef({
      scriptId: "my-script",
      code: "// ==UserScript==\n// @match https://a.test/*\n// ==/UserScript==\nvoid 0;",
      sha256: "aa",
      fallbackName: "my-script",
    });
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.def.runAt, "document-start");
      assert.deepEqual(result.def.grants, []);
      assert.equal(result.def.name, "my-script");
    }
  });

  it("BOM 前缀不阻断头解析", () => {
    const result = buildUserScriptDef({
      scriptId: "bom",
      code: "\uFEFF// ==UserScript==\n// @match https://a.test/*\n// ==/UserScript==\n",
      sha256: "aa",
      fallbackName: "bom",
    });
    assert.ok(result.ok);
  });

  it("fail-closed 拒载：无块 / 缺 @match / 非法 pattern / 未知 run-at / 白名单外 grant", () => {
    const cases: Array<[string, string, RegExp]> = [
      ["no block", "const x = 1;", /metadata block missing/],
      ["no match", "// ==UserScript==\n// @name x\n// ==/UserScript==", /@match missing/],
      [
        "bad pattern",
        "// ==UserScript==\n// @match http://x.test\n// ==/UserScript==",
        /invalid @match pattern/,
      ],
      [
        "bad run-at",
        "// ==UserScript==\n// @match https://a.test/*\n// @run-at someday\n// ==/UserScript==",
        /unknown @run-at/,
      ],
      [
        "bad grant",
        "// ==UserScript==\n// @match https://a.test/*\n// @grant GM_xmlhttpRequest\n// ==/UserScript==",
        /grant not allowed/,
      ],
    ];
    for (const [label, code, reason] of cases) {
      const result = buildUserScriptDef({
        scriptId: label,
        code,
        sha256: "aa",
        fallbackName: label,
      });
      assert.ok(!result.ok, label);
      if (!result.ok) assert.match(result.reason, reason, label);
    }
  });
});
