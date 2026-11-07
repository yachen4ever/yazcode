// 宿主注入面门禁（scripts 侧）：构建入口在污染 env 与洁净 env 下产出一致。
// spec：docs/specs/host-env-injection-boundary.md 验收场景 2。
//
// 覆盖历轮真实出过事的注入形态：mint 双盲 F1（builtin 配置副本被指到宿主
// runtime 副本）、版本元数据烤入宿主版本号、构建环境翻转。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripHostInjectedEnvInPlace } from "../host-env-boundary.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const HOST_INJECTED = {
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/host/runtime/provider/endpoint-a/zcode-builtin.json",
  YAZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/host/runtime/provider/endpoint-a/zcode-builtin.json",
  ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: "/host/runtime/provider/endpoint-b/zcode-builtin.json",
  ZCODIUM_BUILTIN_PROVIDER_CONFIG_FILE: "/host/runtime/provider/endpoint-c/zcode-builtin.json",
  ZCODE_APP_VERSION: "3.17.2",
  ZCODE_ENV: "production",
  ZCODE_AGENT_SERVER_COMMAND: "/tmp/evil/agent",
  ZCODE_HTTP_PROXY: "http://attacker:8080",
  ZCODE_BASE_URL: "https://attacker.example",
  ZCODE_SERVER_AUTH_TOKEN: "host-token",
  PATH: "/usr/bin",
  HOME: "/home/dev",
};

test("构建入口在污染 env 与洁净 env 下读到同一事实源", async () => {
  const { loadBuiltinProviderConfig } = await import("../builtin-provider-config.mjs");
  const polluted = { ...HOST_INJECTED };
  const clean = { PATH: "/usr/bin", HOME: "/home/dev" };
  const fromPolluted = await loadBuiltinProviderConfig({ env: polluted });
  const fromClean = await loadBuiltinProviderConfig({ env: clean });
  assert.equal(fromPolluted.sourcePath, fromClean.sourcePath);
  assert.equal(fromPolluted.sourcePath, resolve(repoRoot, "config/provider/zcode-builtin.json"));
  assert.equal(fromPolluted.content, fromClean.content);
});

test("污染 env 的注入变量不影响构建环境判定（ZCODE_ENV 翻转防线）", async () => {
  const { loadBuiltinProviderConfig } = await import("../builtin-provider-config.mjs");
  // 宿主注入 ZCODE_ENV=production：非 CI 语境下不可信（会被当作发布环境翻转）。
  // 构建期判定只认 CI 注入或 .env 文件，宿主注入的 shell 值不参与。
  // 语境用 ciContext 显式参数钉死（26.5.4 增补批 ②）：此前测试 delete
  // process.env.CI 自救——CI runner 上跑本用例时若不 stub，默认值翻转会让断言
  // 失去语境（2026-11-06 CI 实证）；参数化后语境是显式事实，不再操作环境。
  const polluted = await loadBuiltinProviderConfig({
    env: { ...HOST_INJECTED },
    ciContext: false,
  });
  const clean = await loadBuiltinProviderConfig({ env: { PATH: "/usr/bin" }, ciContext: false });
  assert.equal(polluted.environment, clean.environment);
  assert.notEqual(polluted.environment, "production", "宿主注入的 ZCODE_ENV 不得翻转构建环境");
});

test("scripts 侧原语就地剥离：污染键消失、非污染键保留", () => {
  const env = { ...HOST_INJECTED };
  stripHostInjectedEnvInPlace(env, {
    allowPublishInjection: false,
    allowDevRuntimeKeys: false,
  });
  assert.equal(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, undefined);
  assert.equal(env.YAZCODE_BUILTIN_PROVIDER_CONFIG_FILE, undefined);
  assert.equal(env.ZCODIUM_BUILTIN_PROVIDER_CONFIG_FILE, undefined);
  assert.equal(env.ZCODE_AGENT_SERVER_COMMAND, undefined);
  assert.equal(env.ZCODE_HTTP_PROXY, undefined);
  assert.equal(env.ZCODE_BASE_URL, undefined);
  assert.equal(env.ZCODE_SERVER_AUTH_TOKEN, undefined);
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/dev");
});

test("CI 语境下发布注入集保留（release.yml 合法注入不被误伤）", () => {
  const env = { ...HOST_INJECTED };
  stripHostInjectedEnvInPlace(env, {
    allowPublishInjection: true,
    allowDevRuntimeKeys: false,
  });
  assert.equal(env.ZCODE_APP_VERSION, "3.17.2");
  assert.equal(env.ZCODE_ENV, "production");
  // 非发布注入集的高危项仍被剔除。
  assert.equal(env.ZCODE_AGENT_SERVER_COMMAND, undefined);
  assert.equal(env.ZCODE_HTTP_PROXY, undefined);
  assert.equal(env.ZCODE_BASE_URL, undefined);
});

test("builtin provider 配置的构建期 decode 校验对宿主副本同样生效（事实源不被污染）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "host-env-fixture-"));
  try {
    const fixture = join(dir, "zcode-builtin.json");
    // schema 不兼容的宿主副本（mint F1 同款形态）。
    await writeFile(fixture, "{}", "utf8");
    const { loadBuiltinProviderConfig } = await import("../builtin-provider-config.mjs");
    // 清洗生效 → 宿主副本根本不被读取：事实源仍是仓库文件，构建成功。
    // （反向断言：若清洗失效，这里会读到 fixture 并抛 Invalid Built-in Provider config。）
    const config = await loadBuiltinProviderConfig({
      env: { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: fixture },
    });
    assert.equal(config.sourcePath, resolve(repoRoot, "config/provider/zcode-builtin.json"));
    assert.notEqual(config.sourcePath, fixture);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("构建链 spawn 点继承已洗涤环境（无旁路：整包 process.env 传递点在剥离之后）", () => {
  // 契约 3「无旁路 spawn 点」的机械化断言：构建脚本把整包 process.env 传给子进程
  // （prepare-runtime-assets / prepare-agent-node-bundle / bundle.mjs），只要剥离在
  // 打包进程顶层先执行，子进程继承的就是已洗涤环境。此处验证原语对整包传递语义
  // 成立——剥离后的 env 不含任何白名单外的前缀键。
  const env = { ...HOST_INJECTED };
  stripHostInjectedEnvInPlace(env, {
    allowPublishInjection: false,
    allowDevRuntimeKeys: false,
  });
  const forwarded = { ...env };
  for (const key of Object.keys(forwarded)) {
    assert.equal(
      /^(ZCODE_|YAZCODE_|ZCODIUM_)/.test(key),
      false,
      `传递给子进程的 env 不得含污染前缀键: ${key}`,
    );
  }
});
