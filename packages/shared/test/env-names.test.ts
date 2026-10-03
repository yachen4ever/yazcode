import assert from "node:assert/strict";
import test from "node:test";
import { readExternalEnvVar, writeExternalEnvVar } from "../src/env-names.js";

test("读：新名 YAZCODE_ 优先，旧名 ZCODE_ 兜底", () => {
  const both = { YAZCODE_DATA_BASE_DIR: "/new", ZCODE_DATA_BASE_DIR: "/legacy" };
  assert.equal(readExternalEnvVar(both, "ZCODE_DATA_BASE_DIR"), "/new");

  const onlyLegacy = { ZCODE_DATA_BASE_DIR: "/legacy" };
  assert.equal(readExternalEnvVar(onlyLegacy, "ZCODE_DATA_BASE_DIR"), "/legacy");

  const none = {};
  assert.equal(readExternalEnvVar(none, "ZCODE_DATA_BASE_DIR"), undefined);
});

test("写：新名 + 旧名双写；undefined 双删", () => {
  const env: Record<string, string | undefined> = {};
  writeExternalEnvVar(env, "ZCODE_DATA_BASE_DIR", "/isolated");
  assert.equal(env.YAZCODE_DATA_BASE_DIR, "/isolated");
  assert.equal(env.ZCODE_DATA_BASE_DIR, "/isolated");

  writeExternalEnvVar(env, "ZCODE_DATA_BASE_DIR", undefined);
  assert.equal(env.YAZCODE_DATA_BASE_DIR, undefined);
  assert.equal(env.ZCODE_DATA_BASE_DIR, undefined);
});

test("读：ZCODIUM_ 过渡层作为 legacy 兜底（zcodium 分支期间短暂命名）", () => {
  const interimOnly = { ZCODIUM_DATA_BASE_DIR: "/interim" };
  assert.equal(readExternalEnvVar(interimOnly, "ZCODE_DATA_BASE_DIR"), "/interim");
});

test("不在改名名单的变量原样直读", () => {
  const env = { ZCODE_INTERNAL_ONLY: "/x" };
  assert.equal(readExternalEnvVar(env, "ZCODE_INTERNAL_ONLY"), "/x");
});
