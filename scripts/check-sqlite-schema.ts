// sqlite schema 只增契约驱动（docs/specs/sqlite-schema-contract.md）。
// 基线是实际迁移产物；校验旧列/主键/索引兼容，并要求 schema 变更显式更新可审阅基线。
// 运行方式：node --import tsx scripts/check-sqlite-schema.ts [--update]（pnpm db:schema:check / :update）。
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { TaskIndexRepo } from "../packages/services/src/session/taskIndexRepo.js";
import { AutomationRepo } from "../packages/services/src/session/automationRepo.js";
import { OffPeakTaskRepo } from "../packages/services/src/session/offPeakTaskRepo.js";
import { SQLITE_MIGRATIONS } from "../apps/zcode-cli/packages/adapters/src/storage/session-store/migrations.js";
import { assertAdditiveSchema, dumpSqliteSchema } from "./sqlite-schema-contract.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const update = process.argv.includes("--update");
const base =
  process.env.CI_MERGE_REQUEST_DIFF_BASE_SHA || process.env.SQLITE_SCHEMA_BASE_REF || "HEAD";
const exec = promisify(execFile);
await exec("git", ["rev-parse", "--verify", `${base}^{commit}`], { cwd: repoRoot });
const directory = await mkdtemp(join(tmpdir(), "yazcode-schema-check-"));

// CLI session-store：与 migration-runner 相同的账本表 + 顺序执行迁移 SQL，
// 在内存库上还原迁移完成后的真实 schema。账本 DDL 必须与 runner 逐字一致，
// 否则基线里会出现 runner 不会创建的对象。
const MIGRATION_LEDGER_DDL = `create table if not exists schema_migration (
      id text primary key, checksum text not null, app_version text, time_applied integer not null
    )`;
const cli = new DatabaseSync(":memory:");
cli.exec(MIGRATION_LEDGER_DDL);
for (const migration of SQLITE_MIGRATIONS) cli.exec(migration.sql);

// app tasks-index：三个 Repo 共写同一库文件（与生产一致）。显式传入临时库路径而非
// setDataBaseDir——全局 _dataBaseDir 在 ZCODE_DATA_BASE_DIR 环境覆盖生效时是 no-op，
// 且存在并发覆盖历史（见 AutomationRepo 构造注释）；显式路径两种情况都不受影响。
const appDbPath = join(directory, "tasks-index.sqlite");
const repos = [
  new AutomationRepo(appDbPath),
  new OffPeakTaskRepo(appDbPath),
  new TaskIndexRepo(appDbPath),
];
try {
  for (const repo of repos) await repo.ensureReady();
  const app = new DatabaseSync(appDbPath, { readOnly: true });
  let appSql: string;
  try {
    appSql = dumpSqliteSchema(app);
  } finally {
    app.close();
  }
  const schemas: Array<[string, string]> = [
    ["packages/services/src/session/tasksDatabase/schema.baseline.sql", appSql],
    [
      "apps/zcode-cli/packages/adapters/src/storage/session-store/schema.baseline.sql",
      dumpSqliteSchema(cli),
    ],
  ];
  for (const [path, current] of schemas) {
    // 旧基线来自目标 git 状态；修改本地基线不能绕过只增约束。
    let previous: string | undefined;
    try {
      previous = (await exec("git", ["show", `${base}:${path}`], { cwd: repoRoot })).stdout;
    } catch {
      /* 首次引入该库的基线时没有历史文件。 */
    }
    if (previous) assertAdditiveSchema(previous, current);
    if (update) await writeFile(join(repoRoot, path), current);
    else {
      const baseline = await readFile(join(repoRoot, path), "utf8");
      assertAdditiveSchema(baseline, current);
      assertAdditiveSchema(current, baseline);
      if (baseline !== current)
        throw new Error(`Schema baseline differs: ${path}; review then run pnpm db:schema:update`);
    }
    console.log(`SQLite schema compatible: ${path}`);
  }
} finally {
  for (const repo of repos.toReversed()) repo.close();
  cli.close();
  await rm(directory, { recursive: true, force: true });
}
