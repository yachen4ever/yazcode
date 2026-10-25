import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";
import { resolveDefaultCustomCommandRoots } from "./roots.js";

// 多目录项目 P2（docs/specs/multi-root-projects.md 信任边界白名单）：
// additionalDirectories 只进 commands 发现，每目录追加 project 根并带
// namespace = basename(目录)；排在 cwd 链之后（同名命令 cwd 优先，先到先赢不变）。

describe("resolveDefaultCustomCommandRoots：additionalDirectories 白名单", () => {
  it("每附加目录追加 .zcode/commands 与 .agents/commands project 根，namespace=basename", async () => {
    const roots = await resolveDefaultCustomCommandRoots("/repo/main", {
      additionalDirectories: ["/repo/secondary", "/repo/docs"],
    });
    const additionalRoots = roots.filter((root) => root.namespace !== undefined);
    assert.deepEqual(
      additionalRoots.map((root) => [root.path, root.namespace, root.scope, root.source]),
      [
        [join("/repo/secondary", ".zcode", "commands"), "secondary", "project", "zcode"],
        [join("/repo/secondary", ".agents", "commands"), "secondary", "project", "agents"],
        [join("/repo/docs", ".zcode", "commands"), "docs", "project", "zcode"],
        [join("/repo/docs", ".agents", "commands"), "docs", "project", "agents"],
      ],
    );
  });

  it("附加目录根排在 cwd 链之后；cwd 自身不重复注册", async () => {
    const cwd = "/repo/main";
    const roots = await resolveDefaultCustomCommandRoots(cwd, {
      additionalDirectories: [cwd, "/repo/secondary"],
    });
    const namespacesInOrder = roots.map((root) => root.namespace ?? null);
    assert.equal(namespacesInOrder.filter((namespace) => namespace === "main").length, 0);
    const lastCwdIndex = namespacesInOrder.lastIndexOf(null);
    const firstAdditionalIndex = namespacesInOrder.indexOf("secondary");
    assert.ok(firstAdditionalIndex > lastCwdIndex);
  });

  it("缺省不注入任何附加根", async () => {
    const roots = await resolveDefaultCustomCommandRoots("/repo/main", {});
    assert.equal(roots.some((root) => root.namespace !== undefined), false);
  });
});
