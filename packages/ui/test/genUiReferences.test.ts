import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectGenUiReferences } from "../src/lib/genUiReferences.js";

// 上游历史写法使用 Unicode 私用区分隔符（UE00 开、UE02 协议名后缀、UE01 闭合），
// 测试里用显式转义，避免不可见字符在编辑/评审中丢失。
const token = "\u{E200}visualize\u{E202}{\"path\":\"/work/demo.html\"}\u{E201}";
const directive = '::visualize{path="/work/demo.html" title="工作区体积" mode="wide"}';
const jsonDirective = '::visualize{"path":"/work/demo.html","title":"贝塞尔曲线进阶"}';

describe("Gen UI reference projection", () => {
  it("renders the JSON directive emitted in a completed assistant response", () => {
    assert.deepEqual(projectGenUiReferences(`Before\n${jsonDirective}\nAfter`, true), [
      { kind: "text", text: "Before\n" },
      { kind: "ui", reference: { path: "/work/demo.html", title: "贝塞尔曲线进阶" }, offset: 7 },
      { kind: "text", text: "\nAfter" },
    ]);
  });

  it("decodes JSON escapes without confusing quoted braces or directive text with boundaries", () => {
    const reference = {
      path: String.raw`C:\work area\demo.html`,
      title: 'Group {A} and "B" ::visualize{path="x"}',
      mode: "wide",
    };
    assert.deepEqual(projectGenUiReferences(`::visualize ${JSON.stringify(reference)}`, true), [
      { kind: "ui", reference, offset: 0 },
    ]);
  });

  it("renders the actual model directive with surrounding prose from a completed message", () => {
    assert.deepEqual(projectGenUiReferences(`Before\n${directive}\nAfter`, true), [
      { kind: "text", text: "Before\n" },
      {
        kind: "ui",
        reference: { path: "/work/demo.html", title: "工作区体积", mode: "wide" },
        offset: 7,
      },
      { kind: "text", text: "\nAfter" },
    ]);
  });

  it("preserves original offsets for mixed and repeated marker formats", () => {
    const text = `${directive}\n${token}\n${jsonDirective}`;
    assert.deepEqual(
      projectGenUiReferences(text, true)
        .filter((part) => part.kind === "ui")
        .map((part) => part.offset),
      [0, directive.length + 1, directive.length + token.length + 2],
    );
  });

  it("uses directive quoting rules for braces, escaped quotes and Windows paths", () => {
    const text = String.raw`::visualize{path="C:\work area\demo.html" title="Group {A} and \"B\""}`;
    assert.deepEqual(projectGenUiReferences(text, true), [
      {
        kind: "ui",
        offset: 0,
        reference: { path: String.raw`C:\work area\demo.html`, title: 'Group {A} and "B"' },
      },
    ]);
  });

  for (const text of [
    `\`${directive}\``,
    `\`\`\`text\n${directive}\n\`\`\``,
    `~~~text\n${directive}\n~~~`,
    `<pre>${directive}</pre>`,
    `\`\`\`text\n::visualize{path="`,
    `\`::visualize\``,
    `\`${jsonDirective}\``,
    `\`\`\`text\n${jsonDirective}\n\`\`\``,
  ]) {
    it(`keeps directive examples inert: ${JSON.stringify(text.slice(0, 24))}`, () => {
      for (const completed of [true, false]) {
        assert.deepEqual(projectGenUiReferences(text, completed), [{ kind: "text", text }]);
      }
    });
  }

  it("never mounts a streamed or interrupted directive and suppresses its partial prefix", () => {
    for (const source of [directive, jsonDirective]) {
      for (let length = 2; length <= source.length; length++) {
        const parts = projectGenUiReferences(`Before ${source.slice(0, length)}`, false);
        assert.equal(parts.some((part) => part.kind === "ui"), false);
        assert.deepEqual(
          parts.filter((part) => part.kind === "text"),
          [{ kind: "text", text: "Before " }],
        );
      }
    }
    assert.deepEqual(projectGenUiReferences(directive, false), [{ kind: "pending" }]);
    assert.deepEqual(projectGenUiReferences('::visualize{path="/work/demo.html"', true), [
      { kind: "invalid" },
    ]);
  });

  for (const text of [
    '::visualize{path="https://example.com/demo.html"}',
    '::visualize{path="relative/demo.html"}',
    '::visualize{path="/work/../demo.html"}',
    '::visualize{path="/work/demo.html" mode="fullscreen"}',
    '::visualize{path="/work/demo.html" sessionId="other"}',
    '::visualize{title="No path"}',
    '::visualize{path:"/work/demo.html"}',
    '::visualize{"path":"/work/demo.html",}',
    '::visualize{"path":"/work/demo.html","sessionId":"other"}',
    '::visualize{"path":"/work/demo.html","mode":"fullscreen"}',
    '::visualize{"path":"/work/demo.html","title":7}',
    '::visualize{"path":"/work/../demo.html"}',
    '::visualize{"path":"https://example.com/demo.html"}',
    '::visualize{"path":"/work/demo.html"',
  ]) {
    it(`rejects invalid directive parameters: ${JSON.stringify(text.slice(0, 32))}`, () => {
      assert.deepEqual(projectGenUiReferences(text, true), [{ kind: "invalid" }]);
    });
  }

  for (const text of [
    ':visualize{path="/work/demo.html"}',
    ':::visualize{path="/work/demo.html"}',
    '::visualizer{path="/work/demo.html"}',
  ]) {
    it(`does not extend unrelated directive syntax: ${JSON.stringify(text.slice(0, 24))}`, () => {
      assert.deepEqual(projectGenUiReferences(text, true), [{ kind: "text", text }]);
    });
  }

  it("does not swallow prose after an unclosed JSON directive", () => {
    const text = '::visualize{"path":"/work/demo.html"\nThis is ordinary prose.';
    assert.deepEqual(projectGenUiReferences(text, false), [{ kind: "text", text }]);
  });

  it("only executes references in completed assistant text", () => {
    assert.deepEqual(
      projectGenUiReferences(`before${token}after`, true).map((part) => part.kind),
      ["text", "ui", "text"],
    );
    assert.deepEqual(projectGenUiReferences(token, false), [{ kind: "pending" }]);
  });

  it("leaves quoted code inert and suppresses partial stream markers", () => {
    assert.deepEqual(projectGenUiReferences("```html\nvis", false), [
      { kind: "text", text: "```html\nvis" },
    ]);
    assert.deepEqual(projectGenUiReferences(`\`${token}\``, true), [
      { kind: "text", text: `\`${token}\`` },
    ]);
    assert.deepEqual(
      projectGenUiReferences(`hello\u{E200}visualize\u{E202}{"path":`, false),
      [{ kind: "text", text: "hello" }, { kind: "pending" }],
    );
  });

  it("does not execute malformed paths and preserves repeated occurrences", () => {
    assert.equal(
      projectGenUiReferences(
        "\u{E200}visualize\u{E202}{\"path\":\"https://evil/a.html\"}\u{E201}",
        true,
      )[0]?.kind,
      "invalid",
    );
    assert.equal(
      projectGenUiReferences(token + token, true).filter((part) => part.kind === "ui").length,
      2,
    );
  });
});
