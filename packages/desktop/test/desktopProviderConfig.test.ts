import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveZCodeBuiltinProviderConfigFilePath } from "../src/main/desktopProviderConfigPaths.js";

// 运行时读取源单一化回归（R2 修复，spec：docs/specs/builtin-provider-config-packaging.md）：
// mint 三轮双盲实证——AppImage 在 zcode 宿主会话内启动时，宿主注入的
// ZCODE_BUILTIN_PROVIDER_CONFIG_FILE（GLM runtime 副本，schema 与仓库解析器不匹配）
// 经 env 分支优先于包内路径，绕过 R1 的 extraResources 锁源导致
// 「Bundled 与 Active ZCode Built-in Release 均不可用」。
describe("resolveZCodeBuiltinProviderConfigFilePath", () => {
  const poisonedEnv = {
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/tmp/host-runtime/endpoint-x/zcode-builtin.json",
  };

  it("打包态忽略 env 注入：恒返回包内 resourcesPath 源（单一事实源）", () => {
    const resolved = resolveZCodeBuiltinProviderConfigFilePath({
      isPackaged: true,
      resourcesPath: "/app/resources",
      env: poisonedEnv,
    });
    assert.equal(resolved, "/app/resources/config/provider/zcode-builtin.json");
  });

  it("打包态缺省 env（真实 process.env 被宿主污染）同样不受影响", () => {
    // 空对象形态覆盖「函数内部直接读调用方 env」的分支；打包态分支根本不看 env。
    const resolved = resolveZCodeBuiltinProviderConfigFilePath({
      isPackaged: true,
      resourcesPath: "/app/resources",
      env: {},
    });
    assert.equal(resolved, "/app/resources/config/provider/zcode-builtin.json");
  });

  it("dev 态保留 env 覆盖能力（调试通道）", () => {
    const resolved = resolveZCodeBuiltinProviderConfigFilePath({
      isPackaged: false,
      appPath: "/repo/packages/desktop",
      env: poisonedEnv,
    });
    assert.equal(resolved, "/tmp/host-runtime/endpoint-x/zcode-builtin.json");
  });

  it("dev 态无 env 时回退 appPath 相对源", () => {
    const resolved = resolveZCodeBuiltinProviderConfigFilePath({
      isPackaged: false,
      appPath: "/repo/packages/desktop",
      env: {},
    });
    assert.equal(resolved, "/repo/config/provider/zcode-builtin.json");
  });
});
