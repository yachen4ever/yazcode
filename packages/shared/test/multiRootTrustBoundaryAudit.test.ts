import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 多目录项目 P2 信任边界审计（docs/specs/multi-root-projects.md「信任边界（P2，产品裁决）」
// 与验收场景 4）：additionalDirectories 在 CLI 侧是白名单接线——只允许进入
// skills/commands/subagents 发现与 env-info 展示（含其传输载体与协议线程位），
// 禁止接入 config/AGENTS/MCP/hooks/plugins/memory/permissions 装配（防越期接线）。
//
// 模式参考 packages/shared/test/testScriptContract.test.ts 的源码扫描：逐文件断言
// CLI 侧（apps/zcode-cli）所有 `additionalDirectories` 标识符引用点与白名单**集合相等**——
// 新增引用（含注释里的字面量）必须显式进白名单，白名单条目失去引用同样报错（防漂移）。
//
// 裁决口径（复核 M3 建议 1，2026-10-25）：验收场景 4 从词法「零引用」升级为流动级
// 「零流动」。词法「零引用」不足以作信任边界证明（M3/m3-5 教训）：上游 b0de1476 在
// 同一装配输出对象**显式**携带该字段，yazcode 经 `...options.runtimeConfig` 整体展开
// **隐式**携带——两边都在装配面承载该值，差别只在审计能不能看见。因此词法断言之上
// 追加流动级断言：真实调用 `resolveAppRuntimeConfig`（config/MCP/hooks/plugins/memory/
// permissions 的唯一装配入口，create-app.ts 调用），断言：
// 1. 配置装配面（configResult.config 对象）在调用前后逐字不变，且不含
//    additionalDirectories——任何 `Object.assign(configResult.config, …)` 或整体写回
//    即在此失败；
// 2. 装配出口 runtimeConfig 的键集合与快照相等——新增装配键必须显式更新快照
//    （防静默扩面）；
// 3. 附加目录只经唯一冻结位（AgentRuntimeConfig.additionalDirectories，spec 明示的
//    传输载体）进入 runtime：入参携带时出口按原样承载，入参缺席时出口不得无中生有。
//
// 局限（如实标注）：动态断言在 node:test 进程内经 tsx 加载 CLI 源码图真实执行装配
// 函数本体，但不覆盖宿主侧 create-app.ts 的调用位与真实 Electron 环境——那两层由
// 词法白名单（create-app.ts 在列）继续看护。CLI 依赖包（@zcode/core、@zcode/contracts、
// @zcode/adapters）的 exports 指向 dist 产物，故本断言要求先构建 CLI 包：verify:pre-push
// 与 CI 的 test 阶段都先跑 pnpm build:cli，单独跑本测试前也需先构建一次。

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const CLI_SRC_ROOT = path.join(repositoryRoot, "apps", "zcode-cli", "packages");

/** 白名单：CLI 侧允许出现 additionalDirectories 标识符的全部源文件（相对仓库根）。 */
const ALLOWLIST: ReadonlySet<string> = new Set([
  // ── spec 白名单四消费点 ──
  "apps/zcode-cli/packages/adapters/src/skills/roots.ts", // 1. skills 发现
  "apps/zcode-cli/packages/adapters/src/commands/roots.ts", // 2. commands 发现
  "apps/zcode-cli/packages/bootstrap/src/subagents.ts", // 3. subagents 发现
  "apps/zcode-cli/packages/core/src/context/sections/env-info.ts", // 4. env-info 展示
  // ── 消费载体（白名单内的传输位）──
  "apps/zcode-cli/packages/adapters/src/context/index.ts", // env-info 载体（ContextSource 探测）
  "apps/zcode-cli/packages/core/src/runtime/methods/context.ts", // env-info 请求透传
  "apps/zcode-cli/packages/core/src/runtime/types.ts", // AgentRuntimeConfig 冻结位（派生运行时继承）
  // ── 协议三通道线程位（record/params 装配，非配置装配面）──
  "apps/zcode-cli/packages/contracts/src/interfaces/context-source.port.ts", // EnvInfo/Request 类型
  "apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts", // createRecord/snapshot
  "apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-types.ts", // session record 类型
  "apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-bridge.ts", // 冷恢复 → resume params
  "apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-workspace-config.ts", // slash 命令目录
  "apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts", // subscribe 参数线程
  "apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/cold-session-resume.ts", // 冷恢复协调器
  "apps/zcode-cli/packages/bootstrap/src/custom-commands.ts", // commands 发现 options 线程
  "apps/zcode-cli/packages/bootstrap/src/app/create-app.ts", // skillPort/subagent/contextSource 装配
  "apps/zcode-cli/packages/bootstrap/src/app/script-workflow-child-runtime.ts", // 派生运行时继承
  "apps/zcode-cli/packages/bootstrap/src/app/workflow-facade.ts", // 派生运行时继承
]);

/** 明确禁止接入的配置装配文件（出现引用即测试失败，给出比集合差更直接的报错）。 */
const FORBIDDEN_ASSEMBLY_FILES = [
  "apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts", // config/MCP/hooks/memory 装配
  "apps/zcode-cli/packages/bootstrap/src/mcp-config.ts", // MCP 装配
  "apps/zcode-cli/packages/bootstrap/src/plugins.ts", // 插件装配
  "apps/zcode-cli/packages/bootstrap/src/permission-options.ts", // 权限装配
  "apps/zcode-cli/packages/bootstrap/src/skill-command-overrides.ts", // skill/command 禁用清单
  "apps/zcode-cli/packages/bootstrap/src/app/paths.ts", // memory/config 路径派生
];

const IDENTIFIER_PATTERN = /\badditionalDirectories\b/u;

/** 审计的源码扩展名：.ts / .tsx / .mjs（m3-1：.tsx 渲染面与 .mjs 脚本此前不在扫描范围）。 */
const AUDITED_EXTENSIONS = new Set([".ts", ".tsx", ".mjs"]);

/** 测试文件合法构造夹具，不入审计（源码同放的 node:test 用例除外）。 */
const TEST_FILE_SUFFIXES = [".test.ts", ".test.tsx"];

/** 遍历时跳过的构建产物 / 依赖目录（只审计源码）。 */
const SKIPPED_DIRECTORIES = new Set(["dist", "node_modules"]);

async function listAuditedSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      files.push(...(await listAuditedSourceFiles(path.join(directory, entry.name))));
      continue;
    }
    if (
      entry.isFile() &&
      AUDITED_EXTENSIONS.has(path.extname(entry.name)) &&
      !TEST_FILE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))
    ) {
      files.push(path.join(directory, entry.name));
    }
  }
  return files;
}

async function readRepositoryFile(relativePath: string): Promise<string> {
  return await readFile(path.join(repositoryRoot, relativePath), "utf8");
}

describe("多目录项目信任边界审计（验收场景 4）", () => {
  it("additionalDirectories 在 CLI 侧的引用点与白名单集合相等", async () => {
    const sources = await listAuditedSourceFiles(CLI_SRC_ROOT);
    const referencing: string[] = [];
    for (const sourcePath of sources) {
      const content = await readFile(sourcePath, "utf8");
      if (IDENTIFIER_PATTERN.test(content)) {
        referencing.push(path.relative(repositoryRoot, sourcePath));
      }
    }
    const unexpected = referencing.filter((file) => !ALLOWLIST.has(file)).sort();
    const missing = [...ALLOWLIST].filter((file) => !referencing.includes(file)).sort();
    assert.deepEqual(
      { unexpected, missing },
      { unexpected: [], missing: [] },
      "additionalDirectories 引用点漂移：新增引用必须按 docs/specs/multi-root-projects.md 信任边界显式进白名单；白名单条目失去引用也应从白名单移除",
    );
  });

  it("配置装配文件（config/MCP/hooks/plugins/memory/permissions 路径）零引用", async () => {
    for (const relativePath of FORBIDDEN_ASSEMBLY_FILES) {
      const content = await readRepositoryFile(relativePath);
      assert.equal(
        IDENTIFIER_PATTERN.test(content),
        false,
        `${relativePath} 属配置装配面，禁止出现 additionalDirectories 引用（信任边界：配置装配只沿 workingDirectory 链）`,
      );
    }
  });

  it("白名单四个消费点各自真实引用（防白名单空转）", async () => {
    const consumptionPoints = [
      "apps/zcode-cli/packages/adapters/src/skills/roots.ts",
      "apps/zcode-cli/packages/adapters/src/commands/roots.ts",
      "apps/zcode-cli/packages/bootstrap/src/subagents.ts",
      "apps/zcode-cli/packages/core/src/context/sections/env-info.ts",
    ];
    for (const relativePath of consumptionPoints) {
      const content = await readRepositoryFile(relativePath);
      assert.equal(
        IDENTIFIER_PATTERN.test(content),
        true,
        `${relativePath} 应消费 additionalDirectories（spec 白名单消费点）`,
      );
    }
  });

  it("流动级：resolveAppRuntimeConfig 装配出口零流动到配置装配面（M3 建议 1）", async () => {
    // 动态加载 CLI 装配入口。依赖包 exports 指向 dist：缺产物时的报错给出可执行的补救，
    // 不静默跳过（信任边界断言 fail-open 等于没有）。
    const runtimeConfigModulePath = path.join(
      repositoryRoot,
      "apps",
      "zcode-cli",
      "packages",
      "bootstrap",
      "src",
      "app",
      "runtime-config.ts",
    );
    let resolveAppRuntimeConfig: (input: FlowTestResolveInput) => FlowTestResolveResult;
    try {
      const mod = (await import(pathToFileURL(runtimeConfigModulePath).href)) as {
        resolveAppRuntimeConfig: (input: FlowTestResolveInput) => FlowTestResolveResult;
      };
      resolveAppRuntimeConfig = mod.resolveAppRuntimeConfig;
    } catch (error) {
      throw new Error(
        "流动级断言需要 apps/zcode-cli 的 CLI 包产物（@zcode/core/@zcode/contracts/@zcode/adapters 的 dist exports）。" +
          "先运行 pnpm build:cli（verify:pre-push 与 CI 的 test 阶段都先于 test 构建），再运行本测试。",
        { cause: error },
      );
    }

    const EXTRA_DIRECTORY = "/tmp/flow-audit-extra-root";
    // 最小 configResult.config 夹具：覆盖装配函数读取的全部 config 分支（mcp/permission/
    // skills/toolConcurrency/modelAnomalyGuard/features/memory/hooks）。
    const configResult = {
      config: {
        mcp: { servers: {} },
        permission: { mode: "default" },
        skills: { metadataBudget: 0 },
        toolConcurrency: { maxConcurrency: 1 },
        modelAnomalyGuard: {},
        features: { mcp: true, subagent: true, memory: true },
        memory: { use: true },
        hooks: { events: {} },
      },
    };
    const configBefore = structuredClone(configResult.config);
    const resolveInput = (
      runtimeConfig: Record<string, unknown> | undefined,
    ): FlowTestResolveInput => ({
      cliStorageRoot: "/tmp/flow-audit-cli",
      configResult,
      options: { runtimeConfig, env: {} },
      subagentOutputRootDir: "/tmp/flow-audit-subagents",
      workingDirectory: "/tmp/flow-audit-work",
    });

    // 最坏入参：附加目录在场（spec 明示的唯一传输载体随 runtimeConfig 展开进入）。
    const result = resolveAppRuntimeConfig(
      resolveInput({ additionalDirectories: [EXTRA_DIRECTORY] }),
    );

    // 断言 1：配置装配面零流动——configResult.config 在调用前后逐字不变且不含附加目录。
    assert.deepEqual(
      configResult.config,
      configBefore,
      "resolveAppRuntimeConfig 改写了配置装配面对象（configResult.config）：附加目录禁止写回配置装配",
    );
    assert.equal(
      "additionalDirectories" in configResult.config,
      false,
      "additionalDirectories 出现在配置装配面（configResult.config）：越期接线",
    );
    assert.equal(
      "additionalDirectories" in result.configuredMcpServers,
      false,
      "additionalDirectories 出现在 MCP 装配产物：越期接线",
    );

    // 断言 2：装配出口键集合快照。新增装配键必须显式更新本快照（防静默扩面）。
    // additionalDirectories 在列是 spec 明示的唯一传输载体（AgentRuntimeConfig 冻结位）。
    assert.deepEqual(
      Object.keys(result.runtimeConfig).sort(),
      RUNTIME_CONFIG_ASSEMBLY_KEY_SNAPSHOT,
      "runtimeConfig 装配出口出现快照之外的键：新增装配键须按 docs/specs/multi-root-projects.md 信任边界显式更新快照并复核是否属于配置装配越期接线",
    );
    assert.deepEqual(
      result.runtimeConfig.additionalDirectories,
      [EXTRA_DIRECTORY],
      "唯一冻结位未按入参承载附加目录：AgentRuntimeConfig.additionalDirectories 是 spec 明示的传输载体",
    );

    // 断言 3：入参不带附加目录时，装配出口不得无中生有。
    const cleanResult = resolveAppRuntimeConfig(resolveInput(undefined));
    assert.equal(
      "additionalDirectories" in cleanResult.runtimeConfig,
      false,
      "装配面无中生有 additionalDirectories：附加目录只能来自协议三通道的 record 装配",
    );
  });
});

/** 流动级断言用的最小装配签名（本测试不 import CLI 类型，避免跨包类型依赖）。 */
interface FlowTestResolveInput {
  cliStorageRoot: string;
  configResult: { config: Record<string, unknown> };
  options: { runtimeConfig?: Record<string, unknown>; env?: Record<string, string> };
  persistedMode?: unknown;
  subagentOutputRootDir: string;
  workingDirectory: string;
}

interface FlowTestResolveResult {
  configuredMcpServers: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
  untrustedProjectMcpServers: Set<unknown>;
}

/** 装配出口键集合快照（2026-10-25 @ runtime-config.ts，含唯一传输载体 additionalDirectories）。 */
const RUNTIME_CONFIG_ASSEMBLY_KEY_SNAPSHOT = [
  "additionalDirectories",
  "bashTimeoutPolicy",
  "embeddedSearchBackend",
  "genUiOutputRoot",
  "hooks",
  "language",
  "mcp",
  "memory",
  "mode",
  "modelAnomalyGuard",
  "modelSelection",
  "runtimeFeatures",
  "skillMetadataBudget",
  "subagents",
  "titleGeneration",
  "toolAllowlist",
  "toolConcurrency",
  "toolDisallowlist",
  "userInstructions",
  "visionFallback",
  "workingDirectory",
];
