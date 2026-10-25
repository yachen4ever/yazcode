// 架构治理脚本自测（docs/specs/architecture-governance-self-test.md）。
// 在临时工作区构造最小 policy + 源文件，真跑 checkArchitecture 断言判定语义。
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkArchitecture } from "../architecture/index.mjs";

const POLICY = `
version: 1
global:
  maxFileLines: 50
  forbidCycles: true
  forbidDeepImports: true
  managedOnly: true
modules:
  - id: app
    roots: [app]
    managed: true
    requires: [shared]
    layers:
      domain: domain
      ui: ui
    layerOrder: [domain, ui]
    publicEntrypoints: [app/index.ts]
  - id: shared
    roots: [shared]
    managed: true
    requires: []
    publicEntrypoints: [shared/index.ts]
`;

/** 最小合法工作区：两个 managed 模块各带 module.ts / contract.ts 与公开入口。 */
const BASE_FILES = {
  "app/module.ts": "export const requires = ['shared'];\n",
  "app/contract.ts": "export interface AppContract {\n  run(): void;\n}\n",
  "app/index.ts": "export * from './contract.js';\n",
  "app/domain/service.ts": "import { marker } from '../index.js';\nexport const value = marker;\n",
  "app/ui/view.ts": "import { value } from '../domain/service.js';\nexport const view = value;\n",
  "shared/module.ts": "export const requires = [];\n",
  "shared/contract.ts": "export interface SharedContract {\n  marker: number;\n}\n",
  "shared/index.ts": "export const marker = 1;\n",
};

async function makeWorkspace(extraFiles = {}, policy = POLICY) {
  const cwd = await mkdtemp(path.join(tmpdir(), "arch-selftest-"));
  const merged = { ...BASE_FILES, ...extraFiles };
  const files = { "architecture-policy.yaml": policy };
  // extraFiles 中值为 null 表示从基线文件里剔除该文件。
  for (const [relative, content] of Object.entries(merged)) {
    if (content !== null) files[relative] = content;
  }
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(cwd, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return cwd;
}

const workspaces = [];
after(async () => {
  await Promise.all(workspaces.map((cwd) => rm(cwd, { recursive: true, force: true })));
});

function rulesOf(result) {
  return result.violations.map((item) => item.rule);
}

describe("policy 校验", () => {
  it("模块 id 重复必须抛错", async () => {
    const cwd = await makeWorkspace({}, POLICY.replace("- id: shared", "- id: app"));
    workspaces.push(cwd);
    await assert.rejects(() => checkArchitecture({ cwd }), /重复或为空: app/);
  });

  it("依赖未知模块必须抛错", async () => {
    const cwd = await makeWorkspace(
      {},
      POLICY.replace("requires: [shared]", "requires: [nonexistent]"),
    );
    workspaces.push(cwd);
    await assert.rejects(() => checkArchitecture({ cwd }), /依赖未知模块 nonexistent/);
  });
});

describe("managed 模块工件", () => {
  it("缺少 contract.ts 报 missing-module-artifact", async () => {
    const cwd = await makeWorkspace({ "shared/contract.ts": null });
    workspaces.push(cwd);
    const result = await checkArchitecture({ cwd });
    assert.ok(rulesOf(result).includes("missing-module-artifact"));
  });
});

describe("跨模块依赖与公开入口", () => {
  it("经公开入口的已声明依赖放行", async () => {
    const cwd = await makeWorkspace({
      "app/domain/ok.ts":
        "import { marker } from '../../shared/index.js';\nexport const m = marker;\n",
    });
    workspaces.push(cwd);
    const result = await checkArchitecture({ cwd });
    assert.deepEqual(
      result.violations
        .filter((item) => item.file.endsWith("app/domain/ok.ts"))
        .map((item) => item.rule),
      [],
    );
  });

  it("跨模块深层导入（非公开入口）报 deep-import", async () => {
    const cwd = await makeWorkspace({
      "app/domain/deep.ts":
        "import { marker } from '../../shared/contract.js';\nexport const m = marker;\n",
    });
    workspaces.push(cwd);
    const result = await checkArchitecture({ cwd });
    assert.ok(
      result.violations.some(
        (item) => item.rule === "deep-import" && item.file.endsWith("app/domain/deep.ts"),
      ),
    );
  });

  it("未声明依赖的跨模块导入报 module-dependency", async () => {
    const cwd = await makeWorkspace(
      // module.ts 的 requires 清单会覆盖 policy 声明，两侧要一起改；
      // 跨模块导入（公开入口，避开 deep-import 干扰）在未声明依赖时必须报。
      {
        "app/module.ts": "export const requires = [];\n",
        "app/domain/rogue.ts":
          "import { marker } from '../../shared/index.js';\nexport const m = marker;\n",
      },
      POLICY.replace("requires: [shared]", "requires: []"),
    );
    workspaces.push(cwd);
    const result = await checkArchitecture({ cwd });
    assert.ok(result.violations.some((item) => item.rule === "module-dependency"));
  });
});

describe("层方向", () => {
  it("domain（低层）依赖 ui（高层）报 layer-direction", async () => {
    const cwd = await makeWorkspace({
      "app/ui/state.ts": "export const state = 1;\n",
      "app/domain/upward.ts": "import { state } from '../ui/state.js';\nexport const s = state;\n",
    });
    workspaces.push(cwd);
    const result = await checkArchitecture({ cwd });
    assert.ok(
      result.violations.some(
        (item) => item.rule === "layer-direction" && item.file.endsWith("app/domain/upward.ts"),
      ),
    );
  });

  it("ui（高层）依赖 domain（低层）放行", async () => {
    const cwd = await makeWorkspace({
      "app/ui/downward.ts":
        "import { value } from '../domain/service.js';\nexport const d = value;\n",
    });
    workspaces.push(cwd);
    const result = await checkArchitecture({ cwd });
    assert.deepEqual(
      result.violations
        .filter((item) => item.file.endsWith("app/ui/downward.ts"))
        .map((item) => item.rule),
      [],
    );
  });
});

describe("循环依赖", () => {
  it("managed 模块内 a→b→a 报 cycle（global）", async () => {
    const cwd = await makeWorkspace({
      "shared/a.ts": "import { b } from './b.js';\nexport const a = b;\n",
      "shared/b.ts": "import { a } from './a.js';\nexport const b = a;\n",
    });
    workspaces.push(cwd);
    const result = await checkArchitecture({ cwd });
    const cycle = result.violations.find((item) => item.rule === "cycle");
    assert.ok(cycle, "应报 cycle");
    assert.equal(cycle.global, true);
  });
});

describe("行数上限与豁免", () => {
  const longFile = `${"export const padding = 0;\n".repeat(60)}`;

  it("超过 maxFileLines 报 max-file-lines", async () => {
    const cwd = await makeWorkspace({ "app/long.ts": longFile });
    workspaces.push(cwd);
    const result = await checkArchitecture({ cwd });
    assert.ok(
      result.violations.some(
        (item) => item.rule === "max-file-lines" && item.file.endsWith("app/long.ts"),
      ),
    );
  });

  it("exception 路径命中时不报，过期时报 expired-exception", async () => {
    const cwd = await makeWorkspace(
      { "app/long.ts": longFile },
      `${POLICY}
exceptions:
  - id: legacy-long
    rule: max-file-lines
    paths: [app/long.ts]
    expires: "2030-01-01"
`,
    );
    workspaces.push(cwd);
    const ok = await checkArchitecture({ cwd });
    assert.ok(!rulesOf(ok).includes("max-file-lines"));
    assert.ok(!rulesOf(ok).includes("expired-exception"));

    const expiredCwd = await makeWorkspace(
      { "app/long.ts": longFile },
      `${POLICY}
exceptions:
  - id: legacy-long
    rule: max-file-lines
    paths: [app/long.ts]
    expires: "2020-01-01"
`,
    );
    workspaces.push(expiredCwd);
    const expired = await checkArchitecture({ cwd: expiredCwd });
    assert.ok(
      expired.violations.some((item) => item.rule === "expired-exception" && item.global === true),
    );
  });
});

describe("baseline 消解", () => {
  it("登记 fingerprint 后违规进 baselineViolations 而非 newViolations", async () => {
    const cwd = await makeWorkspace({
      "app/ui/state.ts": "export const state = 1;\n",
      "app/domain/upward.ts": "import { state } from '../ui/state.js';\nexport const s = state;\n",
    });
    workspaces.push(cwd);
    const first = await checkArchitecture({ cwd });
    assert.ok(first.newViolations.length > 0);
    await writeFile(
      path.join(cwd, ".architecture-baseline.json"),
      `${JSON.stringify({ version: 1, violations: first.violations }, null, 2)}\n`,
    );
    const second = await checkArchitecture({ cwd });
    assert.equal(second.newViolations.length, 0);
    assert.equal(second.baselineViolations.length, second.violations.length);
  });
});
