import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseMentionMarkdown } from "../src/mentions/mentionMarkdown.js";
import { mapAdditionalRootFileToMentionItem } from "../src/mentions/providers/fileMentionProvider.js";

/** P3d 文件提及跨 roots（docs/specs/multi-root-projects.md「P3d」）。 */

describe("mapAdditionalRootFileToMentionItem", () => {
  it("非 cwd root 的文件提及用绝对路径引用并标注 rootName 来源", () => {
    const item = mapAdditionalRootFileToMentionItem(
      { name: "index.ts", relativePath: "src/index.ts", path: "/repos/lib/src/index.ts", type: "file" },
      "/repos/lib",
    );
    assert.equal(item.label, "index.ts");
    assert.equal(item.description, "lib/src/index.ts");
    assert.equal(item.value, "/repos/lib/src/index.ts");
    // markdown destination 必须是绝对路径（cwd 命中才是相对路径）。
    assert.equal(
      item.markdown,
      "[index.ts](/repos/lib/src/index.ts)",
    );
    assert.deepEqual(parseMentionMarkdown(item.markdown), [
      { type: "file", label: "index.ts" },
    ]);
    assert.ok(item.keywords.includes("lib"));
  });

  it("目录命中补尾斜杠，回显层能恢复目录语义", () => {
    const item = mapAdditionalRootFileToMentionItem(
      { name: "utils", relativePath: "src/utils", path: "/repos/lib/src/utils", type: "directory" },
      "/repos/lib",
    );
    assert.equal(item.markdown, "[utils](/repos/lib/src/utils/)");
    assert.deepEqual(parseMentionMarkdown(item.markdown), [
      { type: "directory", label: "utils" },
    ]);
  });
});
