import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEV_CHANNEL_ENV_ALLOWLIST,
  DEV_RUNTIME_ONLY_ENV_ALLOWLIST,
  HOST_INJECTION_ENV_PREFIXES,
  PUBLISH_INJECTION_ENV_ALLOWLIST,
  isHostInjectionEnvKey,
  resolveHostEnvAllowlist,
  stripHostInjectedEnv,
  stripHostInjectedEnvInPlace,
} from "../src/hostEnvBoundary.js";

/**
 * 宿主注入面回归门禁（spec：docs/specs/host-env-injection-boundary.md 验收场景 1）。
 *
 * 污染 env 覆盖历轮真实出过事的全部注入形态——mint 双盲 F1（builtin 配置副本）、
 * 版本烤入宿主版本号、构建环境翻转，以及总账 R1–R8 组的高危面（鉴权令牌、
 * 代理、数据根、可执行文件路径、端点 origin）。
 */
const POLLUTED_ENV: Record<string, string> = {
  // F1 同款：builtin 配置路径（bundled 与 personal）
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/host/runtime/provider/endpoint-a/zcode-builtin.json",
  YAZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/host/runtime/provider/endpoint-a/zcode-builtin.json",
  ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: "/host/runtime/provider/endpoint-b/zcode-builtin.json",
  YAZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: "/host/runtime/provider/endpoint-b/zcode-builtin.json",
  // 官方 legacy 前缀（改名表第三顺位兜底）——注意：改名变量的 legacy 名是合法
  // 白名单项（读侧 readExternalEnvVar 会兜底读它），故此处用未登记改名的 legacy 键
  // 作为污染面样本。
  ZCODIUM_BUILTIN_PROVIDER_CONFIG_FILE: "/host/runtime/provider/endpoint-c/zcode-builtin.json",
  ZCODIUM_AGENT_SERVER_COMMAND: "/tmp/evil/agent",
  // R1 凭据/鉴权
  ZCODE_SERVER_AUTH_TOKEN: "host-token",
  ZCODE_SERVER_HOST: "0.0.0.0",
  ZCODE_HTTP_PROXY: "http://attacker:8080",
  ZCODE_AGENT_CA_CERT: "/host/ca.pem",
  // R2 路径语义
  ZCODE_DESKTOP_USER_DATA_DIR: "/host/userdata",
  ZCODE_DESKTOP_SESSION_DATA_DIR: "/host/session",
  ZCODE_DESKTOP_APPLICATION_NAME: "HostApp",
  ZCODE_WEB_STATIC_ROOT: "/host/www",
  // R3 端点语义
  // R4 计费权益
  ZCODE_OFFPEAK_MOCK: "1",
  ZCODE_OFFPEAK_MOCK_NO_PLAN: "1",
  // R5 可执行文件
  ZCODE_AGENT_SERVER_COMMAND: "/tmp/evil/agent",
  ZCODE_AGENT_SERVER_ARGS_JSON: '["--exec","/tmp/evil"]',
  ZCODE_AGENT_SERVER_CWD: "/tmp/evil",
  ZCODE_LARK_CLI_BINARY: "/tmp/evil/lark",
  // R6 功能开关
  ZCODE_DYNAMIC_WORKFLOW_MODE: "off",
  ZCODE_E2E_FS_FAULTS_ALLOW: "1",
  ZCODE_RUNTIME_ENV: "development",
  // 发布注入集形态（本地构建不信任；CI 才可信）
  ZCODE_APP_VERSION: "3.17.2",
  ZCODE_DIST_BASE_URL: "https://attacker.example/releases/",
  ZCODIUM_REMOTE_ASSET_CDN_BASE_URL: "https://attacker.example/cdn/",
  // 非注入面键：必须原样保留
  PATH: "/usr/bin",
  HOME: "/home/dev",
  NODE_OPTIONS: "--max-old-space-size=4096",
  LANG: "zh-CN.UTF-8",
};

describe("hostEnvBoundary：deny-by-default 原语", () => {
  it("三条宿主注入前缀都被识别为污染面", () => {
    for (const prefix of HOST_INJECTION_ENV_PREFIXES) {
      assert.equal(isHostInjectionEnvKey(`${prefix}SOMETHING`), true, prefix);
    }
    assert.equal(isHostInjectionEnvKey("PATH"), false);
    assert.equal(isHostInjectionEnvKey("NODE_OPTIONS"), false);
  });

  it("污染 env 全量注入 → 白名单外的前缀键全剔，非前缀键原样保留", () => {
    const cleaned = stripHostInjectedEnv(POLLUTED_ENV);
    const allowlist = resolveHostEnvAllowlist();
    for (const key of Object.keys(cleaned)) {
      if (!isHostInjectionEnvKey(key)) continue;
      // 存活的前缀键只能是白名单项（dev 通道集）。
      assert.ok(allowlist.has(key), `白名单外的前缀键必须被剔除: ${key}`);
    }
    // 非注入面键逐个保留。
    assert.equal(cleaned.PATH, "/usr/bin");
    assert.equal(cleaned.HOME, "/home/dev");
    assert.equal(cleaned.NODE_OPTIONS, "--max-old-space-size=4096");
    assert.equal(cleaned.LANG, "zh-CN.UTF-8");
    // 污染集里的高危项逐个确认已被剔除。
    for (const key of [
      "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
      "YAZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
      "ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE",
      "YAZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE",
      "ZCODIUM_BUILTIN_PROVIDER_CONFIG_FILE",
      "ZCODIUM_AGENT_SERVER_COMMAND",
      "ZCODE_SERVER_AUTH_TOKEN",
      "ZCODE_SERVER_HOST",
      "ZCODE_HTTP_PROXY",
      "ZCODE_AGENT_CA_CERT",
      "ZCODE_WEB_STATIC_ROOT",
      "ZCODE_OFFPEAK_MOCK",
      "ZCODE_OFFPEAK_MOCK_NO_PLAN",
      "ZCODE_AGENT_SERVER_COMMAND",
      "ZCODE_AGENT_SERVER_ARGS_JSON",
      "ZCODE_AGENT_SERVER_CWD",
      "ZCODE_LARK_CLI_BINARY",
      "ZCODE_DYNAMIC_WORKFLOW_MODE",
      "ZCODE_RUNTIME_ENV",
    ]) {
      assert.equal(cleaned[key], undefined, `污染面键必须被剔除: ${key}`);
    }
  });

  it("dev 通道白名单存活（开发者显式配置不是宿主注入）", () => {
    const devEnv: Record<string, string> = {
      ZCODE_ENV: "test",
      ZCODE_DATA_BASE_DIR: "/tmp/yazcode-dev",
      YAZCODE_DATA_BASE_DIR: "/tmp/yazcode-dev",
      ZCODE_DESKTOP_HOME_DIR: "/tmp/yazcode-home",
      ZCODE_DESKTOP_AGENT_BYTECODE: "1",
      ZCODE_E2E_COVERAGE: "1",
      ZCODE_CDN_BASE_URL: "https://dev.example",
      ZCODE_BASE_URL: "https://dev.example/api",
      ZCODE_ENDPOINT_ORIGIN: "https://dev.example",
      // 仅 dev 态可信族（桌面数据隔离目录）：dev 态存活。
      ZCODE_DESKTOP_USER_DATA_DIR: "/tmp/yazcode-userdata",
    };
    // dev 启动器是唯一可信上下文 → 显式开启 dev-runtime-only 族。
    const cleaned = stripHostInjectedEnv(devEnv, { allowDevRuntimeKeys: true });
    for (const key of Object.keys(devEnv)) {
      assert.ok(
        DEV_CHANNEL_ENV_ALLOWLIST.includes(key) ||
          DEV_RUNTIME_ONLY_ENV_ALLOWLIST.includes(key),
        `dev 通道键须在白名单: ${key}`,
      );
      assert.equal(cleaned[key], devEnv[key], `dev 通道键必须存活: ${key}`);
    }
  });

  it("打包态剔除仅 dev 可信族（桌面隔离目录）：宿主不得顶替用户数据落盘位置", () => {
    // 总账 R2 组：ZCODE_DESKTOP_USER_DATA_DIR 等被顶替 → 登录态/窗口状态写入宿主
    // 目录；ZCODE_DESKTOP_APPLICATION_NAME 被顶替 → 单实例锁错配。
    const devRuntimeEnv: Record<string, string> = {
      ZCODE_DESKTOP_USER_DATA_DIR: "/host/userdata",
      ZCODE_DESKTOP_SESSION_DATA_DIR: "/host/session",
      ZCODE_DESKTOP_APPLICATION_NAME: "HostApp",
      ZCODE_DESKTOP_HOME_DIR: "/host/home",
      ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA: "1",
      // E2E 故障注入门控：宿主注入即可在生产打开 FS 故障注入（总账 R6）。
      ZCODE_E2E_FS_FAULTS_ALLOW: "1",
      // 端点与资源源：宿主顶替即改道 API 流量或把攻击者源烤进产物（总账 R3/R8）。
      ZCODE_BASE_URL: "https://attacker.example/api",
      ZCODE_ENDPOINT_ORIGIN: "https://attacker.example",
      ZCODE_CDN_BASE_URL: "https://attacker.example",
      ZCODE_REMOTE_ASSET_CDN_BASE_URL: "https://attacker.example/assets",
    };
    const packaged = stripHostInjectedEnv(devRuntimeEnv, { allowDevRuntimeKeys: false });
    assert.deepEqual(Object.keys(packaged), []);
  });

  it("发布注入集仅在 CI 语境可信（版本烤入事故防线）", () => {
    // 本地构建：宿主可能注入同名旧版本号/发行源 → 不可信。
    const local = stripHostInjectedEnv({
      ZCODE_APP_VERSION: "3.17.2",
      ZCODE_DIST_BASE_URL: "https://attacker.example/",
    });
    assert.deepEqual(Object.keys(local), []);
    // CI 发布链：release.yml 合法注入的变量保留。
    const ci = stripHostInjectedEnv(
      { ZCODE_APP_VERSION: "26.5.4", ZCODE_DIST_BASE_URL: "https://github.com/x/y/" },
      { allowPublishInjection: true },
    );
    assert.deepEqual(Object.keys(ci).sort(), ["ZCODE_APP_VERSION", "ZCODE_DIST_BASE_URL"]);
    for (const key of PUBLISH_INJECTION_ENV_ALLOWLIST) {
      assert.ok(PUBLISH_INJECTION_ENV_ALLOWLIST.includes(key));
    }
  });

  it("白名单解析：dev 通道恒含，发布注入与 dev-runtime-only 按开关", () => {
    const withoutPublish = resolveHostEnvAllowlist();
    // ZCODE_ENV 属 dev-runtime-only（构建环境翻转防线）：默认不信任。
    assert.equal(withoutPublish.has("ZCODE_ENV"), false);
    assert.equal(resolveHostEnvAllowlist({ allowDevRuntimeKeys: true }).has("ZCODE_ENV"), true);
    assert.equal(withoutPublish.has("ZCODE_APP_VERSION"), false);
    const withPublish = resolveHostEnvAllowlist({ allowPublishInjection: true });
    assert.equal(withPublish.has("ZCODE_APP_VERSION"), true);
    // extraAllowlist 追加生效。
    const extra = resolveHostEnvAllowlist({ extraAllowlist: ["ZCODE_TEST_ONLY"] });
    assert.equal(extra.has("ZCODE_TEST_ONLY"), true);
  });

  it("就地剥离与纯函数版本语义一致，且不改非污染键", () => {
    const target: Record<string, string | undefined> = { ...POLLUTED_ENV };
    stripHostInjectedEnvInPlace(target);
    assert.equal(target.PATH, "/usr/bin");
    assert.equal(target.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, undefined);
    assert.equal(target.YAZCODE_BUILTIN_PROVIDER_CONFIG_FILE, undefined);
    assert.equal(target.ZCODIUM_BUILTIN_PROVIDER_CONFIG_FILE, undefined);
    // undefined 值按环境语义剔除。
    const withUndefined: Record<string, string | undefined> = { A: undefined, B: "1" };
    assert.deepEqual(stripHostInjectedEnv(withUndefined), { B: "1" });
  });

  it("污染 env 输入不得被修改（纯函数契约）", () => {
    const source = { ...POLLUTED_ENV };
    const snapshot = { ...source };
    stripHostInjectedEnv(source);
    assert.deepEqual(source, snapshot);
  });
});
