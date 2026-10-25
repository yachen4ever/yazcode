import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

/**
 * 根 barrel（src/index.ts）必须保持 browser-safe：renderer 对 @zcode/services 的值导入
 * 会把 barrel 的整条相对导入链拉进浏览器模块图，任何一层顶层触达 node:* 都会让
 * renderer 模块图整体死亡（P1b-1 的 ProjectRepository 值导出曾打黑 dev renderer）。
 *
 * 本守卫静态解析 barrel 的值 re-export（`export type` 编译期擦除，豁免），沿相对导入
 * 做传递闭包，任何被值导出路径触达的模块顶层出现 node:* 即失败。外部包（@zcode/shared
 * 等）不在本守卫范围，各自有 browser-safe 契约。
 */

function stripCommentsAndTypeStatements(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/(?:import|export)\s+type\s+[^;]*?;/g, "");
}

function collectRelativeSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/from\s*"(\.[^"]+)"/g)) specifiers.push(match[1] ?? "");
  for (const match of source.matchAll(/import\s*"(\.[^"]+)"/g)) specifiers.push(match[1] ?? "");
  return specifiers;
}

function findNodeSpecifier(source: string): string | null {
  const hit = source.match(/(?:from|import\s*|require\()\s*"node:[^"]+"/);
  return hit ? (hit[0].trim() ?? null) : null;
}

function resolveModule(spec: string, fromDir: string): string {
  const literal = resolve(fromDir, spec);
  // 源码用 NodeNext 风格说明符：".js"/".mjs" 指向同名的 ".ts"/".mts" 源文件。
  const candidates = [literal];
  if (literal.endsWith(".js")) candidates.push(literal.slice(0, -3) + ".ts");
  if (literal.endsWith(".mjs")) candidates.push(literal.slice(0, -4) + ".mts");
  return candidates.find((candidate) => existsSync(candidate)) ?? literal;
}

test("根 barrel 及其值导出闭包保持 browser-safe（不含 node:* 顶层依赖）", () => {
  const entryFile = resolve(srcDir, "index.ts");
  const queue = [entryFile];
  const visited = new Set<string>();
  const violations: string[] = [];

  while (queue.length > 0) {
    const file = queue.shift();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    assert.ok(existsSync(file), `守卫解析到的模块不存在：${file}`);

    const source = stripCommentsAndTypeStatements(readFileSync(file, "utf8"));
    const nodeHit = findNodeSpecifier(source);
    if (nodeHit) {
      violations.push(`${file} → ${nodeHit}`);
      continue;
    }
    for (const spec of collectRelativeSpecifiers(source)) {
      queue.push(resolveModule(spec, dirname(file)));
    }
  }

  assert.deepEqual(
    violations,
    [],
    `根 barrel 的值导出闭包触达了 node:* 模块（renderer 会因此无法挂载）；\n` +
      `值导出一律走模块路径或 node 入口，勿加回 src/index.ts：\n${violations.join("\n")}`,
  );
});
