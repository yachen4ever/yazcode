import assert from "node:assert/strict";
import test from "node:test";
import {
  appSettingsPatchSchema,
  appSettingsSchema,
  embeddedBrowserUserscriptsSettingsSchema,
} from "@zcode/shared";

test("embeddedBrowserUserscripts：缺省字段向后兼容，旧配置加载不报错", () => {
  const legacy = appSettingsSchema.parse({});
  assert.equal(legacy.embeddedBrowserUserscripts, undefined);

  const oldStyle = appSettingsSchema.parse({ memoryProvider: "local", locale: "zh-CN" });
  assert.equal(oldStyle.embeddedBrowserUserscripts, undefined);
});

test("embeddedBrowserUserscripts：合法 manifest 完整保留（含 sha256 锚定）", () => {
  const parsed = appSettingsSchema.parse({
    embeddedBrowserUserscripts: {
      "hide-ai-copilot": { enabled: true, sha256: "abc123" },
      "pending-anchor": { enabled: true },
      "disabled-one": { enabled: false, sha256: "def456" },
    },
  });
  assert.deepEqual(parsed.embeddedBrowserUserscripts, {
    "hide-ai-copilot": { enabled: true, sha256: "abc123" },
    "pending-anchor": { enabled: true },
    "disabled-one": { enabled: false, sha256: "def456" },
  });
});

test("embeddedBrowserUserscripts：patch 写入合法值通过（锚定回写路径）", () => {
  const parsed = appSettingsPatchSchema.parse({
    embeddedBrowserUserscripts: { "hide-ai-copilot": { enabled: true, sha256: "abc123" } },
  });
  assert.equal(parsed.embeddedBrowserUserscripts?.["hide-ai-copilot"]?.sha256, "abc123");
});

test("embeddedBrowserUserscripts：条目损坏降级为禁用，不连累整个设置文件解析", () => {
  // enabled 非布尔/缺省的条目必须降级而不是让 appSettingsSchema.parse 抛错——
  // 否则一次坏的 manifest 编辑会触发设置文件隔离（quarantine），毁掉无关设置。
  const parsed = appSettingsSchema.parse({
    embeddedBrowserUserscripts: {
      "bad-entry": { enabled: "yes", sha256: "abc" },
      "missing-enabled": { sha256: "abc" },
    },
  });
  // 整条损坏（enabled 非布尔）→ catch 丢弃整条降级为禁用；
  // 仅缺 enabled → default 补 false 并保留其余字段。
  assert.deepEqual(parsed.embeddedBrowserUserscripts?.["bad-entry"], { enabled: false });
  assert.deepEqual(parsed.embeddedBrowserUserscripts?.["missing-enabled"], {
    enabled: false,
    sha256: "abc",
  });
});

test("embeddedBrowserUserscripts：整表非对象降级为空表", () => {
  for (const bad of [42, "nope", ["x"]]) {
    const parsed = embeddedBrowserUserscriptsSettingsSchema.parse(bad);
    assert.deepEqual(parsed, {});
  }
});

test("embeddedBrowserUserscripts：M4 不变量 pendingApproval ⇒ enabled=false（放行/拒绝矩阵）", () => {
  const parseEntry = (entry: unknown) =>
    appSettingsSchema.parse({ embeddedBrowserUserscripts: { s: entry } })
      .embeddedBrowserUserscripts?.s;

  // 放行矩阵：合法组合原样保留（enabled 缺省补 false）。
  assert.deepEqual(parseEntry({ enabled: true, sha256: "abc123" }), {
    enabled: true,
    sha256: "abc123",
  });
  assert.deepEqual(parseEntry({ enabled: true }), { enabled: true });
  assert.deepEqual(parseEntry({ enabled: false, pendingApproval: true }), {
    enabled: false,
    pendingApproval: true,
  });
  assert.deepEqual(parseEntry({ enabled: false }), { enabled: false });

  // 拒绝矩阵：禁态 {enabled:true, pendingApproval:true} 违反 superRefine，
  // 整条目拒绝（catch 降级禁用），不让整份设置文件解析失败。
  assert.deepEqual(parseEntry({ enabled: true, pendingApproval: true }), { enabled: false });
  assert.deepEqual(parseEntry({ enabled: true, sha256: "abc123", pendingApproval: true }), {
    enabled: false,
  });

  // patch 写入路径共用同一条目 schema，禁态同样拒绝（手工 patch 造不出待批准启用态）。
  const patched = appSettingsPatchSchema.parse({
    embeddedBrowserUserscripts: { s: { enabled: true, pendingApproval: true } },
  });
  assert.deepEqual(patched.embeddedBrowserUserscripts?.s, { enabled: false });
});
