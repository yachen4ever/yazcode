import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

// 打包事实源锁定回归：宿主 CLI 会话会向子进程注入
// ZCODE/YAZCODE_BUILTIN_PROVIDER_CONFIG_FILE 指向宿主 runtime 副本（schema 可能比
// 仓库解析器新），electron-builder.config.js 的 extraResources.from 一旦被污染，
// 产出「宿主 schema 内容 + 仓库旧解析器」的包，运行时解码 ZodError，表现为
// 「Bundled 与 Active ZCode Built-in Release 均不可用」（mint 双盲 F1）。
// spec 见 docs/specs/builtin-provider-config-packaging.md。
const repositoryConfigPath = fileURLToPath(
  new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
);

/** 用不兼容 schema 的 fixture 模拟宿主 runtime 副本（decode 必失败）。 */
function writeIncompatibleFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "host-builtin-config-"));
  const fixturePath = join(dir, "zcode-builtin.json");
  // 运行时 releaseSchema 要求 schemaVersion === 1 且带模板字段；空对象必然 ZodError。
  writeFileSync(fixturePath, "{}", "utf8");
  return fixturePath;
}

interface BuilderConfig {
  extraResources: Array<{ from: string; to: string }>;
}

/** extraResources 中 builtin 配置副本的打包条目（事实源契约本体）。 */
async function loadBuiltinConfigEntry(importCase: string): Promise<{ from: string; to: string }> {
  // cache-busting query 强制重新执行 config 顶层，让本次注入真实进入加载流程。
  const config = (await import(`../electron-builder.config.js?case=${importCase}`))
    .default as BuilderConfig;
  const entry = config.extraResources.find((item) => item.to === "config/provider/zcode-builtin.json");
  assert.ok(entry, "extraResources 必须包含 config/provider/zcode-builtin.json 副本条目");
  return entry;
}

describe("builtin provider 配置打包事实源", () => {
  const injectedEnvKeys: string[] = [];
  const originalValues = new Map<string, string | undefined>();

  function injectEnv(key: string, value: string): void {
    if (!originalValues.has(key)) originalValues.set(key, process.env[key]);
    process.env[key] = value;
    injectedEnvKeys.push(key);
  }

  afterEach(() => {
    for (const key of injectedEnvKeys) {
      const original = originalValues.get(key);
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
    injectedEnvKeys.length = 0;
  });

  it("stripHostInjectedBuiltinProviderEnv 剔除新旧前缀宿主注入变量，保留合法构建变量", async () => {
    const { stripHostInjectedBuiltinProviderEnv } = await import(
      "../../../scripts/builtin-provider-config.mjs"
    );
    const cleaned = stripHostInjectedBuiltinProviderEnv({
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/tmp/host/active.json",
      YAZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/tmp/host/active.json",
      ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: "/tmp/host/bundled.json",
      YAZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: "/tmp/host/bundled.json",
      // release.yml 合法注入的变量必须保留，不得被前缀清洗误伤。
      ZCODE_APP_VERSION: "26.5.2",
      ZCODE_ENV: "test",
      PATH: "/usr/bin",
    } as Record<string, string>);
    assert.deepEqual(Object.keys(cleaned).sort(), ["PATH", "ZCODE_APP_VERSION", "ZCODE_ENV"]);
    // 清洗必须是纯函数：不改原对象（调用方可能还要用原始 env 组装子进程）。
    const source = { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/tmp/host/active.json" };
    stripHostInjectedBuiltinProviderEnv(source);
    assert.equal(source.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, "/tmp/host/active.json");
  });

  it("宿主注入不兼容 fixture 时，extraResources 事实源仍锁定仓库文件（清洗生效）", async () => {
    const fixturePath = writeIncompatibleFixture();
    injectEnv("ZCODE_BUILTIN_PROVIDER_CONFIG_FILE", fixturePath);
    injectEnv("YAZCODE_BUILTIN_PROVIDER_CONFIG_FILE", fixturePath);
    // 若清洗缺失，loadBuiltinProviderConfig 读到 fixture 会直接 ZodError 抛出，
    // 本用例以加载失败形态失败；清洗生效则 from 必须指向仓库事实源。
    const entry = await loadBuiltinConfigEntry("host-injected");
    assert.equal(entry.from, repositoryConfigPath);
    rmSync(fixturePath, { force: true });
  });

  it("干净环境导入 config，事实源同样解析为仓库文件", async () => {
    const entry = await loadBuiltinConfigEntry("clean");
    assert.equal(entry.from, repositoryConfigPath);
  });

  it("loadBuiltinProviderConfig 单点防御：污染 env 直传时事实源仍锁定仓库（R2）", async () => {
    // R2 实证：prepare-prebuilds/SEA 等链路经本函数直吃 process.env，宿主注入
    // 指向 GLM runtime 副本时构建即炸；清洗收编进函数后所有消费链统一受保护。
    const { loadBuiltinProviderConfig } = await import(
      "../../../scripts/builtin-provider-config.mjs"
    );
    const config = await loadBuiltinProviderConfig({
      env: {
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/tmp/host-runtime/endpoint-x/zcode-builtin.json",
        YAZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/tmp/host-runtime/endpoint-x/zcode-builtin.json",
      },
    });
    assert.equal(config.sourcePath, repositoryConfigPath);
  });
});
