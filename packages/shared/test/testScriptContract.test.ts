import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 这个用例守护的是「测试脚本能否在任意 workspace 上下文下跑起来」，不是脚本内容本身。
//
// 背景：apps/zcode-cli 是嵌套的独立 pnpm workspace。从嵌套上下文调用子包脚本时，
// PATH 里只有嵌套 workspace 的 node_modules/.bin，不含根的 tsx 可执行文件，
// 于是 `tsx --test ...` 直接报 `sh: tsx: command not found`。
//
// 关键点：补 devDependencies 修不好这个问题——pnpm 不为嵌套 workspace 的成员建独立
// 依赖树（apps/zcode-cli/packages/core/node_modules 里连 cheerio 这类直接依赖都没有，
// 全部向上解析到根 node_modules），所以包级声明既装不进该包目录，也进不了嵌套上下文
// 的 PATH。唯一稳的写法是 `node --import tsx --test`：它走 Node 的模块解析
// （逐级向上找 node_modules/tsx），在根与嵌套两种上下文下都成立。
//
// 契约见 docs/specs/test-gate-integration.md 的行为规则 2。

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

const manifests = [
  "package.json",
  "packages/shared/package.json",
  "packages/ui/package.json",
  "packages/services/package.json",
  "packages/desktop/package.json",
  "packages/zcode-cua/package.json",
  "apps/zcode-cli/package.json",
  "apps/zcode-cli/packages/core/package.json",
  "apps/zcode-cli/packages/adapters/package.json",
  "apps/zcode-cli/packages/contracts/package.json",
];

async function readManifest(relativePath: string) {
  const raw = await readFile(path.join(repositoryRoot, relativePath), "utf8");
  return JSON.parse(raw) as { name?: string; scripts?: Record<string, string> };
}

describe("测试脚本的加载器引入方式", () => {
  it("所有包的 test 脚本都不裸调 tsx 二进制", async () => {
    const offenders: string[] = [];
    for (const relativePath of manifests) {
      const manifest = await readManifest(relativePath);
      const test = manifest.scripts?.test;
      if (!test) continue;
      // `tsx --test` 这类写法依赖 PATH 上的可执行文件；`node --import tsx --test`
      // 依赖模块解析。前者在嵌套 workspace 上下文下必然失败。
      // 正则要排除 `--import tsx --test`——那里的 tsx 是模块名不是可执行文件名。
      if (/(^|\s)tsx\s+--test/u.test(test) && !test.includes("--import tsx")) {
        offenders.push(`${manifest.name ?? relativePath}: ${test}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "以下包的 test 脚本裸调了 tsx 二进制，在嵌套 workspace 上下文下会报 " +
        "`sh: tsx: command not found`。请改用 `node --import tsx --test`。",
    );
  });

  it("需要 tsx 加载器的包都用 node --import tsx 形式引入", async () => {
    const offenders: string[] = [];
    for (const relativePath of manifests) {
      const manifest = await readManifest(relativePath);
      const test = manifest.scripts?.test;
      if (!test) continue;
      // 用了 tsx 加载器的脚本必须以 node --import tsx 开头。
      if (test.includes("tsx") && !/^node\s+--import\s+tsx\b/u.test(test)) {
        offenders.push(`${manifest.name ?? relativePath}: ${test}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "以下包的 test 脚本用了 tsx 却没有用 `node --import tsx` 形式引入加载器。",
    );
  });

  it("test 脚本的 glob 一律用引号形式，避免依赖 shell 展开", async () => {
    const offenders: string[] = [];
    for (const relativePath of manifests) {
      const manifest = await readManifest(relativePath);
      const test = manifest.scripts?.test;
      if (!test) continue;
      // 抓出所有含 ** 的 glob token，判断它是否被引号包住。
      for (const token of test.split(/\s+/)) {
        if (!token.includes("**")) continue;
        const quoted =
          (token.startsWith('"') && token.endsWith('"')) ||
          (token.startsWith("'") && token.endsWith("'"));
        if (!quoted) offenders.push(`${manifest.name ?? relativePath}: ${token}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "以下 glob 没有加引号，会退化为 shell 展开（`**` 不递归时只匹配一层，漏掉深层测试文件）。",
    );
  });
});
