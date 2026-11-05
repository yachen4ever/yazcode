// desktop 发版矩阵合同（上游 ZCodium #108 同款模式精简版）：
// macos-14 于 2026-11-02 退役（actions/runner-images#13518）后这类 runner 退役是
// 静默发版阻断（CI 直接红且难排查），这里把 runner↔目标架构的映射锁成显式合同，
// runner 未来再退役时由本测试先行失败暴露。上轮调研依据 docs/upstream-port-tasks-20261105.md。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const workflow = parse(
  await readFile(join(repoRoot, ".github/workflows/release.yml"), "utf8"),
);

test("desktop matrix 的 mac 构建绑定原生 ARM64 runner，不回退退役版本", () => {
  const macTargets = workflow.jobs.desktop.strategy.matrix.include.filter(
    (target) => target.target === "mac" || target.runner.startsWith("macos-"),
  );
  // 本仓已移除 Intel mac 构建（release.yml 注释，用户拍板），仅 arm64 一行；
  // macos-15 是 ARM64 原生——若未来引入 Intel 目标必须显式用 macos-15-intel，不得跟随同名系统版本。
  assert.deepEqual(macTargets, [
    { runner: "macos-15", target: "mac", arch: "arm64", glob: "*.dmg" },
  ]);
});

test("desktop job 的 runner 与 bundle 命令由 matrix 驱动", () => {
  const desktop = workflow.jobs.desktop;
  assert.equal(desktop["runs-on"], "${{ matrix.runner }}");
  const bundle = desktop.steps.find((step) => /pnpm\s+bundle:desktop\b/.test(step.run ?? ""));
  assert.equal(
    bundle?.run,
    "pnpm bundle:desktop -- --os ${{ matrix.target }} --arch ${{ matrix.arch }}",
  );
});
