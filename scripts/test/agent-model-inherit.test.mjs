import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * 资产守卫：官方插件子代理（apps/zcode-cli/packages/<plugin>/agents/*.md）的
 * frontmatter `model` 不得硬编码官方账号 provider（`account:` 前缀）。
 *
 * 根因（26.5.10，issue #34）：fork 环境（内网 newapi、未连接官方账号）下
 * `model: account:bigmodel-individual-coding-plan/...` 无法解析——子代理启动报
 * `Cannot start subagent: Account connection unavailable
 * [reason=account-connection-unavailable]`（resolveSubagentSelection）。
 * visual-judge × 3（documents/pdf/spreadsheets 插件）曾全部命中，修正为
 * `model: inherit`（继承主会话模型；packages/shared 的 INHERIT_NAMES 语义）。
 *
 * 本守卫防上游同步把硬编码带回：允许 `inherit` 或本地可解析的 provider/model
 * 字符串；`account:` 前缀一律拒绝。
 */

const repoRoot = resolve(import.meta.dirname, "../..");
const packagesRoot = join(repoRoot, "apps/zcode-cli/packages");

function collectAgentFiles() {
  const entries = readdirSync(packagesRoot, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const agentsDir = join(packagesRoot, entry.name, "agents");
    if (!existsSync(agentsDir)) continue;
    for (const file of readdirSync(agentsDir)) {
      if (!file.endsWith(".md")) continue;
      files.push({ plugin: entry.name, filePath: join(agentsDir, file) });
    }
  }
  return files;
}

function readFrontmatterModel(filePath) {
  const content = readFileSync(filePath, "utf8");
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const modelLine = match[1]
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("model:"));
  if (!modelLine) return null;
  return modelLine.slice("model:".length).trim();
}

describe("官方插件子代理 model 资产守卫（26.5.10，issue #34）", () => {
  it("agents/*.md 的 frontmatter model 不得硬编码官方账号 provider", () => {
    const files = collectAgentFiles();
    assert.ok(
      files.length > 0,
      "应至少存在一个插件子代理定义（apps/zcode-cli/packages/*/agents/*.md）",
    );
    const violations = [];
    for (const { plugin, filePath } of files) {
      const model = readFrontmatterModel(filePath);
      if (model === null) continue;
      if (model.startsWith("account:")) {
        violations.push(`${plugin}/${filePath.split("/").pop()}: model: ${model}`);
      }
    }
    assert.deepEqual(
      violations,
      [],
      `子代理 model 不得指向 fork 环境不可达的官方账号 provider（应改 inherit）：\n${violations.join("\n")}`,
    );
  });

  it("visual-judge 三个定义均为 model: inherit（#34 回归守卫）", () => {
    const expected = ["documents-plugin", "pdf-plugin", "spreadsheets-plugin"];
    for (const plugin of expected) {
      const filePath = join(packagesRoot, plugin, "agents", "visual-judge.md");
      assert.ok(existsSync(filePath), `缺少 ${plugin}/agents/visual-judge.md`);
      assert.equal(
        readFrontmatterModel(filePath),
        "inherit",
        `${plugin}/agents/visual-judge.md 的 model 必须为 inherit（继承主会话模型）`,
      );
    }
  });
});
