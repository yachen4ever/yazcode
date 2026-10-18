import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  EXCLUDED_OFFICIAL_PLUGIN_ASSET_NAMES,
  INCLUDED_OFFICIAL_PLUGIN_TOP_LEVEL_PATHS,
  OFFICIAL_PLUGIN_STAGE_LIST,
} from "../scripts/official-plugin-stage-list.mjs";

// bootstrap 的官方插件定义是 TS 源码，属于构建图事实而非 desktop 的类型依赖：
// 用运行期动态 import（tsx loader 负责 .ts）而不是静态 import，避免 tsc 把
// bootstrap 源码拉进 desktop 的类型检查范围。Windows 绝对路径必须转 file URL。
const definitionsModuleUrl = pathToFileURL(
  join(
    fileURLToPath(import.meta.url),
    "../../../../apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts",
  ),
).href;
const { OFFICIAL_PLUGIN_DEFINITIONS } = await import(definitionsModuleUrl);

test("stage list entries anchor to real official plugin definitions", () => {
  const definitionNames = new Set(OFFICIAL_PLUGIN_DEFINITIONS.map((d) => d.name));
  for (const entry of OFFICIAL_PLUGIN_STAGE_LIST) {
    assert.ok(
      definitionNames.has(entry.definitionName),
      `stage entry ${entry.packageName} anchors to unknown definition "${entry.definitionName}"`,
    );
  }
  const anchors = new Set(OFFICIAL_PLUGIN_STAGE_LIST.map((entry) => entry.definitionName));
  assert.equal(
    anchors.size,
    OFFICIAL_PLUGIN_STAGE_LIST.length,
    "stage entries must not duplicate a definitionName",
  );
});

// 有 listing 但有意不随桌面包分发的插件：运行时从官方 marketplace CDN 按需安装。
// 这里显式登记"已知豁免"，防止新增 listed 插件时再次静默漏 stage（visualize@26.2.0 前科）；
// 反向也守护：这些名字若补了 stage 条目应从豁免表移除。
const LISTED_BUT_RUNTIME_INSTALL_ONLY = new Set([
  "android-emulator",
  "image-search",
  "ios-simulator",
  "restore-legacy-sessions",
  "plugin-creator",
  "skill-creator",
  "zcode-guide",
]);

test("every listed (marketplace-visible) definition is staged or explicitly exempted", () => {
  for (const definition of OFFICIAL_PLUGIN_DEFINITIONS) {
    if (definition.listing === undefined) continue;
    const staged = OFFICIAL_PLUGIN_STAGE_LIST.some(
      (candidate) => candidate.definitionName === definition.name,
    );
    if (staged) continue;
    assert.ok(
      LISTED_BUT_RUNTIME_INSTALL_ONLY.has(definition.name),
      `official plugin "${definition.name}" has a marketplace listing but no desktop stage ` +
        "entry and is not in LISTED_BUT_RUNTIME_INSTALL_ONLY — decide: bundle it (add a " +
        "stage-list entry) or ship it runtime-install-only (exempt it here explicitly)",
    );
  }
  // 豁免表不能指向不存在的定义，防止清理定义后豁免变成摆设。
  const listedNames = new Set(
    OFFICIAL_PLUGIN_DEFINITIONS
      .filter((definition) => definition.listing !== undefined)
      .map((definition) => definition.name),
  );
  for (const exempt of LISTED_BUT_RUNTIME_INSTALL_ONLY) {
    assert.ok(
      listedNames.has(exempt),
      `LISTED_BUT_RUNTIME_INSTALL_ONLY contains "${exempt}" which is no longer a listed definition`,
    );
  }
});

test("stage entries never lag behind definition requiredSeedPaths", () => {
  for (const definition of OFFICIAL_PLUGIN_DEFINITIONS) {
    const entry = OFFICIAL_PLUGIN_STAGE_LIST.find(
      (candidate) => candidate.definitionName === definition.name,
    );
    if (!entry) continue;
    // requiredSeedPaths 与 requiredRuntimePaths 都保证对应文件会出现在 stage 树里
    // （后者是构建产物，如 browser-use 的 docs/*.json），守护时取并集。
    // requiresRuntime 条目的 dist/** 树由 runtime 构建整体产出（node-repl-host 还含
    // stageCuaDriverRuntime 暂存的 @trycua/cua-driver 子树），不逐路径列清单，跳过。
    const stagedGuarantees = new Set([
      ...(entry.requiredSeedPaths ?? []),
      ...(entry.requiredRuntimePaths ?? []),
    ]);
    for (const requiredPath of definition.requiredSeedPaths ?? []) {
      if (entry.requiresRuntime && requiredPath.startsWith("dist/")) continue;
      assert.ok(
        stagedGuarantees.has(requiredPath),
        `official plugin "${definition.name}" requires seed asset "${requiredPath}" ` +
          "that the desktop stage list does not stage",
      );
    }
  }
});

test("staged top-level paths cover every staged seed asset", () => {
  for (const entry of OFFICIAL_PLUGIN_STAGE_LIST) {
    for (const seedPath of entry.requiredSeedPaths ?? []) {
      const topLevel = seedPath.split("/")[0];
      assert.ok(
        INCLUDED_OFFICIAL_PLUGIN_TOP_LEVEL_PATHS.has(topLevel),
        `stage entry ${entry.packageName} seeds "${seedPath}" but top-level path ` +
          `"${topLevel}" is not in INCLUDED_OFFICIAL_PLUGIN_TOP_LEVEL_PATHS`,
      );
      for (const segment of seedPath.split("/")) {
        assert.ok(
          !EXCLUDED_OFFICIAL_PLUGIN_ASSET_NAMES.has(segment),
          `stage entry ${entry.packageName} seeds "${seedPath}" but segment ` +
            `"${segment}" is excluded by the copy filter`,
        );
      }
    }
  }
});
