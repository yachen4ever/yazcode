import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsPatchSchema, appSettingsSchema } from "@zcode/shared";

test("visionFallback：缺省字段向后兼容，旧配置加载不报错且功能关闭", () => {
  const legacy = appSettingsSchema.parse({});
  assert.equal(legacy.visionFallback, undefined);

  // 存量 setting.json 只有旧字段时同样解析成功。
  const oldStyle = appSettingsSchema.parse({ memoryProvider: "local", locale: "zh-CN" });
  assert.equal(oldStyle.visionFallback, undefined);
});

test("visionFallback：enabled 缺省按 false 处理，不默认开启", () => {
  const parsed = appSettingsSchema.parse({
    visionFallback: { providerId: "gw", modelId: "qwen38" },
  });
  assert.ok(parsed.visionFallback);
  assert.notEqual(parsed.visionFallback.enabled, true);
});

test("visionFallback：合法配置完整保留", () => {
  const parsed = appSettingsSchema.parse({
    visionFallback: { enabled: true, providerId: "gw", modelId: "qwen38" },
  });
  assert.deepEqual(parsed.visionFallback, {
    enabled: true,
    providerId: "gw",
    modelId: "qwen38",
  });
});

test("visionFallback：patch 写入合法值通过", () => {
  const parsed = appSettingsPatchSchema.parse({
    visionFallback: { enabled: true, providerId: "gw", modelId: "qwen38" },
  });
  assert.equal(parsed.visionFallback?.enabled, true);
  assert.equal(parsed.visionFallback?.modelId, "qwen38");
});

test("visionFallback：非法 providerId/modelId（空串/非字符串）拒绝", () => {
  for (const bad of [
    { enabled: true, providerId: "  ", modelId: "qwen38" },
    { enabled: true, providerId: "gw", modelId: "" },
    { enabled: true, providerId: 42, modelId: "qwen38" },
  ]) {
    assert.throws(
      () => appSettingsPatchSchema.parse({ visionFallback: bad }),
      (error: unknown) => error instanceof Error,
      `应拒绝非法配置: ${JSON.stringify(bad)}`,
    );
  }
});
