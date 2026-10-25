import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { additionalDirectoryNamespace } from "@zcode/contracts";
import { resolveDefaultSkillRoots } from "./roots.js";
import { NodeSkillAdapter } from "./index.js";

// 多目录项目 P2（docs/specs/multi-root-projects.md 信任边界白名单）：
// additionalDirectories 只进 skills 发现，namespace = basename(目录)，
// 同名技能两个 root 并存、来源可辨（验收场景 1）。

describe("additionalDirectoryNamespace", () => {
  it("取路径末段（兼容 Windows 反斜杠），空段过滤", () => {
    assert.equal(additionalDirectoryNamespace("/repo/secondary"), "secondary");
    assert.equal(additionalDirectoryNamespace("D:\\repo\\docs\\"), "docs");
    assert.equal(additionalDirectoryNamespace("/"), "/");
  });
});

describe("resolveDefaultSkillRoots：additionalDirectories 白名单", () => {
  it("每附加目录追加 .zcode/skills 与 .agents/skills project 根，namespace=basename", async () => {
    const cwd = "/repo/main";
    const roots = await resolveDefaultSkillRoots(cwd, {
      additionalDirectories: ["/repo/secondary", "/repo/docs"],
    });
    const additionalRoots = roots.filter((root) => root.namespace !== undefined);
    assert.deepEqual(
      additionalRoots.map((root) => [root.path, root.namespace, root.scope]),
      [
        [join("/repo/secondary", ".zcode", "skills"), "secondary", "project"],
        [join("/repo/secondary", ".agents", "skills"), "secondary", "project"],
        [join("/repo/docs", ".zcode", "skills"), "docs", "project"],
        [join("/repo/docs", ".agents", "skills"), "docs", "project"],
      ],
    );
  });

  it("附加目录根排在 cwd 链之后（cwd 同名优先），且不与 cwd 自身重复", async () => {
    const cwd = "/repo/main";
    const roots = await resolveDefaultSkillRoots(cwd, {
      additionalDirectories: [cwd, "/repo/secondary"],
    });
    const namespacesInOrder = roots.map((root) => root.namespace ?? null);
    // cwd 自身的根不带 namespace；"/repo/secondary" 的根在全部 cwd 根之后。
    assert.equal(namespacesInOrder.filter((namespace) => namespace === "main").length, 0);
    const lastCwdIndex = namespacesInOrder.lastIndexOf(null);
    const firstAdditionalIndex = namespacesInOrder.indexOf("secondary");
    assert.ok(firstAdditionalIndex > lastCwdIndex);
    assert.ok(!namespacesInOrder.slice(0, firstAdditionalIndex).includes("secondary"));
  });

  it("缺省不注入任何附加根", async () => {
    const roots = await resolveDefaultSkillRoots("/repo/main", {});
    assert.equal(roots.some((root) => root.namespace !== undefined), false);
  });
});

describe("NodeSkillAdapter：附加目录技能的 namespace 限定", () => {
  let workspace: string;
  let cwdSkills: string;
  let additionalSkills: string;

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "multiroot-skills-"));
    cwdSkills = join(workspace, "main", ".zcode", "skills", "deploy");
    additionalSkills = join(workspace, "secondary", ".agents", "skills", "deploy");
    await mkdir(cwdSkills, { recursive: true });
    await mkdir(additionalSkills, { recursive: true });
    await writeFile(
      join(cwdSkills, "SKILL.md"),
      "---\nname: deploy\ndescription: main repo deploy skill\n---\nmain body",
    );
    await writeFile(
      join(additionalSkills, "SKILL.md"),
      "---\nname: deploy\ndescription: secondary repo deploy skill\n---\nsecondary body",
    );
  });

  after(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("同名技能两个 root 并存、来源可辨；qualifiedName 可作为加载名", async () => {
    const adapter = new NodeSkillAdapter();
    const workingDirectory = join(workspace, "main");
    const cwdRoot = {
      path: join(workspace, "main", ".zcode", "skills"),
      scope: "project" as const,
      source: "zcode" as const,
      priority: 10,
    };
    const additionalRoot = {
      path: join(workspace, "secondary", ".agents", "skills"),
      scope: "project" as const,
      source: "agents" as const,
      priority: 40,
      namespace: "secondary",
    };
    const outcome = await adapter.discoverSkills({
      workingDirectory,
      roots: [cwdRoot, additionalRoot],
    });
    // 同名技能两个 root 并存。
    const deploys = outcome.skills.filter((skill) => skill.name === "deploy");
    assert.equal(deploys.length, 2);
    const mainSkill = deploys.find((skill) => skill.rootPath === cwdRoot.path);
    const secondarySkill = deploys.find((skill) => skill.rootPath === additionalRoot.path);
    assert.ok(mainSkill);
    assert.ok(secondarySkill);
    // cwd root 不带 namespace 限定；附加目录以 `<namespace>:<name>` 可辨。
    assert.equal(mainSkill?.qualifiedName, undefined);
    assert.equal(secondarySkill?.qualifiedName, "secondary:deploy");
    // qualifiedName 可作为加载名（与 plugin 同机制）。
    const loaded = await adapter.loadSkill({
      name: "secondary:deploy",
      workingDirectory,
      roots: [cwdRoot, additionalRoot],
    });
    assert.equal(loaded.metadata.qualifiedName, "secondary:deploy");
    assert.equal(loaded.baseDirectory, additionalSkills);
  });
});
