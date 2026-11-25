import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  redactSettingsForLog,
  redactedSettingsJsonForLog,
} from "../src/setting/redactSettingsForLog.js";

// issue #46 回归：settings 日志曾用 JSON.stringify(settings) 整体落盘——
// openvikingConnection.userKey（OV 用户密钥）与内部服务地址以明文进入 console。
// 本文件先把 HOME/数据目录指向沙箱，再动态加载 settingService，捕获 console 输出断言无明文。
// node:test 每个测试文件独立进程，env 与 console 覆盖不会外溢。

const sandboxHome = mkdtempSync(join(tmpdir(), "zcode-setting-log-redaction-"));
process.env.ZCODE_DESKTOP_HOME_DIR = sandboxHome;
// 数据目录沿用改名后的新名（ZCODE_ 旧名仍兼容但会打弃用警告）。
process.env.YAZCODE_DATA_BASE_DIR = join(sandboxHome, "data");
// 打开 development 运行时，让 debugLog 的读路径日志也进入捕获（写路径日志始终输出）。
process.env.ZCODE_RUNTIME_ENV = "development";

test("凭据类键脱敏：嵌套对象/数组 + 大小写不敏感", () => {
  const settings = {
    memoryProvider: "openviking",
    openvikingConnection: {
      url: "http://192.168.5.7:1933",
      userKey: "ov-user-secret-9f8e7d6c",
      verifiedAt: 1730000000000,
    },
    modelProviders: [
      { name: "a", apiKey: "sk-live-abcdef123456" },
      { name: "b", API_TOKEN: "tok-0123456789ab", nested: { password: "p@ssw0rd-very-long" } },
    ],
  };
  const redacted = redactSettingsForLog(settings);

  const serialized = JSON.stringify(redacted);
  // 明文不得出现（凭据与内部地址整串均不得出现）
  for (const plaintext of [
    "ov-user-secret-9f8e7d6c",
    "sk-live-abcdef123456",
    "tok-0123456789ab",
    "p@ssw0rd-very-long",
    "192.168.5.7:1933",
  ]) {
    assert.ok(!serialized.includes(plaintext), `脱敏后仍包含明文: ${plaintext}`);
  }
  // 保留可辨识前缀/后缀与协议，供换 key、换部署排查
  assert.equal(redacted.openvikingConnection.userKey, "ov-u...7d6c");
  assert.equal(redacted.openvikingConnection.url, "http://***");
  assert.equal(redacted.modelProviders[0].apiKey, "sk-l...3456");
  assert.equal(redacted.modelProviders[1].API_TOKEN, "tok-...89ab");
  assert.equal(redacted.modelProviders[1].nested.password, "p@ss...long");
  // 非敏感字段保持原值（写盘日志仍保留调试价值）
  assert.equal(redacted.memoryProvider, "openviking");
  assert.equal(redacted.openvikingConnection.verifiedAt, 1730000000000);
  assert.equal(redacted.modelProviders[0].name, "a");
});

test("短凭据全长掩码，空串与非字符串按约定处理", () => {
  const redacted = redactSettingsForLog({
    password: "short",
    token: "12345678",
    userKey: "",
    apiKey: 42,
    secret: { not: "a string" },
  });
  assert.equal(redacted.password, "*****");
  assert.equal(redacted.token, "********");
  assert.equal(redacted.userKey, "");
  assert.equal(redacted.apiKey, "[REDACTED]");
  assert.equal(redacted.secret, "[REDACTED]");
});

test("地址类键只保留 scheme，非 URL 值整串打码", () => {
  const redacted = redactSettingsForLog({
    url: "https://192.168.5.7:1933/api/v1",
    baseUrl: "  http://internal-host:8080  ",
    endpoint: "not-a-url-host:9999",
  });
  assert.equal(redacted.url, "https://***");
  assert.equal(redacted.baseUrl, "http://***");
  assert.equal(redacted.endpoint, "[REDACTED]");
});

test("深度上限防意外环，超出后返回占位符", () => {
  type Nest = { child?: Nest; leaf?: string };
  const root: Nest = {};
  let cursor = root;
  for (let index = 0; index < 14; index += 1) {
    cursor.child = {};
    cursor = cursor.child;
  }
  cursor.leaf = "bottom-value";
  const redacted = redactSettingsForLog(root) as unknown as Record<string, unknown>;
  assert.ok(JSON.stringify(redacted).includes("[DEPTH-LIMIT]"));
  assert.ok(!JSON.stringify(redacted).includes("bottom-value"));
});

test("redactedSettingsJsonForLog 输出不含明文 userKey（日志形态）", () => {
  const output = redactedSettingsJsonForLog({
    openvikingConnection: { url: "http://127.0.0.1:1933", userKey: "ov-secret-key-123456" },
  });
  assert.ok(!output.includes("ov-secret-key-123456"));
  assert.ok(!output.includes("127.0.0.1:1933"));
  assert.ok(output.includes("http://***"));
});

test("settingService 写盘/读取日志不含明文 userKey 与内部地址（issue #46 回归）", async (t) => {
  const captured: string[] = [];
  const originalLog = console.log;
  const originalDebug = console.debug;
  console.log = (...args: unknown[]) => {
    captured.push(args.map((entry) => String(entry)).join(" "));
  };
  console.debug = (...args: unknown[]) => {
    captured.push(args.map((entry) => String(entry)).join(" "));
  };
  t.after(() => {
    console.log = originalLog;
    console.debug = originalDebug;
    rmSync(sandboxHome, { recursive: true, force: true });
  });

  const { createSettingServiceWithMigrations } = await import("../src/setting/settingService.js");
  const { service } = createSettingServiceWithMigrations();

  // 假值（loopback 地址 + 合成 key）：真实凭据/内网地址不进入测试。
  const fakeUserKey = "ov-test-log-redaction-9f8e7d6c";
  const fakeUrl = "http://127.0.0.1:1933";
  await service.update({
    memoryProvider: "openviking",
    openvikingConnection: { url: fakeUrl, userKey: fakeUserKey, verifiedAt: 1 },
  });
  // 触发读取路径（debugLog "read result:"），development 运行时下才会输出。
  await service.get();

  const output = captured.join("\n");
  assert.ok(output.includes("writing settings to:"), `未捕获到写盘日志:\n${output}`);
  assert.ok(output.includes("read result:"), `未捕获到读取日志:\n${output}`);
  assert.ok(!output.includes(fakeUserKey), `日志泄露明文 userKey:\n${output}`);
  assert.ok(!output.includes("127.0.0.1:1933"), `日志泄露服务地址:\n${output}`);
  assert.ok(output.includes("ov-t...7d6c"), `缺少可辨识掩码:\n${output}`);
  assert.ok(output.includes("http://***"), `URL 未按 scheme 打码:\n${output}`);
  // 非敏感字段仍可读（调试价值保留）
  assert.ok(output.includes('"memoryProvider":"openviking"'), `非敏感字段被误删:\n${output}`);
});
