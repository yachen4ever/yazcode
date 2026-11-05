// 契约内核单测（docs/specs/sqlite-schema-contract.md 验收场景 2 的规则分解）。
// 用例与上游 zai-org main@3c5b2276 的 sqlite-schema-contract.test.mjs 对齐。
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertAdditiveSchema } from "../sqlite-schema-contract.mjs";
const baseline =
  "CREATE TABLE tasks(workspace_key TEXT,task_id TEXT,PRIMARY KEY(workspace_key,task_id)); CREATE INDEX task_idx ON tasks(task_id);";
test("nullable/defaulted additions preserve old writes and composite identity", () => {
  assert.doesNotThrow(() =>
    assertAdditiveSchema(
      baseline,
      baseline +
        "ALTER TABLE tasks ADD COLUMN project_id TEXT; ALTER TABLE tasks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;",
    ),
  );
});
for (const [name, sql] of [
  ["column removal", "CREATE TABLE tasks(task_id TEXT); CREATE INDEX task_idx ON tasks(task_id);"],
  [
    "identity change",
    "CREATE TABLE tasks(workspace_key TEXT,task_id TEXT PRIMARY KEY); CREATE INDEX task_idx ON tasks(task_id);",
  ],
  ["required addition", baseline + "ALTER TABLE tasks ADD COLUMN host TEXT NOT NULL;"],
  [
    "index removal",
    "CREATE TABLE tasks(workspace_key TEXT,task_id TEXT,PRIMARY KEY(workspace_key,task_id));",
  ],
])
  test(`rejects ${name}`, () => assert.throws(() => assertAdditiveSchema(baseline, sql)));

test("preserves automatic UNIQUE keys and their collation/order", () => {
  const old = "CREATE TABLE tasks(id TEXT, title TEXT COLLATE NOCASE, UNIQUE(id,title DESC));";
  for (const next of [
    "CREATE TABLE tasks(id TEXT,title TEXT COLLATE NOCASE);",
    "CREATE TABLE tasks(id TEXT,title TEXT,UNIQUE(id,title DESC));",
    "CREATE TABLE tasks(id TEXT,title TEXT COLLATE NOCASE,UNIQUE(id,title ASC));",
    "CREATE TABLE tasks(id TEXT,title TEXT COLLATE NOCASE,UNIQUE(title DESC,id));",
  ])
    assert.throws(() => assertAdditiveSchema(old, next));
  assert.doesNotThrow(() =>
    assertAdditiveSchema(old, old + "ALTER TABLE tasks ADD COLUMN extra TEXT;"),
  );
});
test("rejects removal/change/addition of CHECK and automatic UNIQUE on old tables", () => {
  const old =
    "CREATE TABLE tasks(id TEXT CHECK(length(id) > 0), value TEXT CHECK(value <> 'CHECK(fake)'));";
  for (const next of [
    "CREATE TABLE tasks(id TEXT, value TEXT);",
    "CREATE TABLE tasks(id TEXT CHECK(length(id) >= 0), value TEXT CHECK(value <> 'CHECK(fake)'));",
    "CREATE TABLE tasks(id TEXT CHECK(length(id) > 0) UNIQUE, value TEXT CHECK(value <> 'CHECK(fake)'));",
    old + "ALTER TABLE tasks ADD COLUMN extra TEXT CHECK(extra <> 'x');",
  ])
    assert.throws(() => assertAdditiveSchema(old, next));
  assert.doesNotThrow(() =>
    assertAdditiveSchema(old, old + "ALTER TABLE tasks ADD COLUMN extra TEXT;"),
  );
});
test("SQL normalization preserves string literal case in indexes and CHECK", () => {
  const table = "CREATE TABLE tasks(id TEXT, phase TEXT);";
  assert.throws(() =>
    assertAdditiveSchema(
      table + "CREATE INDEX status ON tasks(id) WHERE phase='COMPLETE';",
      table + "CREATE INDEX status ON tasks(id) WHERE phase='complete';",
    ),
  );
  assert.throws(() =>
    assertAdditiveSchema(
      "CREATE TABLE tasks(phase TEXT CHECK(phase='COMPLETE'));",
      "CREATE TABLE tasks(phase TEXT CHECK(phase='complete'));",
    ),
  );
  assert.doesNotThrow(() =>
    assertAdditiveSchema(
      table + "CREATE INDEX status ON tasks(id) WHERE phase='complete';",
      table + "create index status on tasks(id) where phase = 'complete';",
    ),
  );
});

// ——基线解析（docs/specs/sqlite-schema-contract.md 防篡改段，上游 #90 加固回流）——
// 负向场景：pre-push 在提交后运行，「破坏性迁移 + 更新后 baseline 同提交」时 HEAD
// 已含新 baseline，HEAD 基线会让校验静默通过；merge-base 基线把 previous 钉在
// 分叉点（旧 baseline），破坏性演化被 assertAdditiveSchema 检出。
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSchemaBase } from "../sqlite-schema-contract.mjs";

const execFile = promisify(execFileCallback);

/** 临时仓 fixture：初始分支名用 trunk，避免命中 resolveSchemaBase 的 main 候选。 */
async function initTempRepo() {
  const repo = await mkdtemp(join(tmpdir(), "schema-base-"));
  await execFile("git", ["init", "-q", "-b", "trunk", repo]);
  await execFile("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
  await execFile("git", ["-C", repo, "config", "user.name", "test"]);
  return repo;
}

async function git(repo, args) {
  return (await execFile("git", ["-C", repo, ...args])).stdout.trim();
}

test("resolveSchemaBase：分支提交后基线取 merge-base 而非 HEAD（防同提交绕过）", async () => {
  const repo = await initTempRepo();
  try {
    await git(repo, ["commit", "--allow-empty", "-m", "base"]);
    const forkPoint = await git(repo, ["rev-parse", "HEAD"]);
    // 在分叉点建 main（fixture 初始分支是 trunk，避免误命中候选），再分出 feature 前进。
    await git(repo, ["branch", "main"]);
    await git(repo, ["checkout", "-b", "feature", "main"]);
    await git(repo, ["commit", "--allow-empty", "-m", "feature work"]);

    const { base, label } = await resolveSchemaBase({ cwd: repo, env: {} });
    assert.equal(base, forkPoint, "基线必须钉在 merge-base，不能用已含本次提交的 HEAD");
    assert.match(label, /merge-base/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("resolveSchemaBase：显式变量优先，无效显式值忽略并回退 merge-base", async () => {
  const repo = await initTempRepo();
  try {
    await git(repo, ["commit", "--allow-empty", "-m", "base"]);
    await git(repo, ["branch", "main"]);
    await git(repo, ["checkout", "-b", "feature", "main"]);
    await git(repo, ["commit", "--allow-empty", "-m", "wip"]);
    const featureHead = await git(repo, ["rev-parse", "HEAD"]);
    const forkPoint = await git(repo, ["merge-base", "HEAD", "main"]);

    // 显式有效变量直接采用。
    const explicit = await resolveSchemaBase({
      cwd: repo,
      env: { SQLITE_SCHEMA_BASE_REF: featureHead },
    });
    assert.equal(explicit.base, featureHead);
    assert.match(explicit.label, /explicit/);

    // 无效 CI 变量被忽略（内部告警），落到 merge-base。
    const invalidCi = await resolveSchemaBase({
      cwd: repo,
      env: { CI_MERGE_REQUEST_DIFF_BASE_SHA: "deadbeef" },
    });
    assert.equal(invalidCi.base, forkPoint);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("resolveSchemaBase：无任何目标分支候选时回退 HEAD（调用方告警）", async () => {
  const repo = await initTempRepo();
  try {
    // trunk 孤仓：无 origin/*、无 main 本地分支、无显式/CI 变量。
    await git(repo, ["commit", "--allow-empty", "-m", "only"]);
    const { base, label } = await resolveSchemaBase({ cwd: repo, env: {} });
    assert.equal(base, "HEAD");
    assert.match(label, /HEAD/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
