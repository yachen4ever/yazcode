import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";

// 迁移逻辑按 getDataBaseDir() 相对运作；测试用 setDataBaseDir 指向独立临时 base，
// 不依赖 env、不触碰真实 HOME。node:test 每文件独立进程，互不影响。

async function loadPaths() {
  return import("../src/paths.js");
}

function makeBase() {
  return mkdtempSync(join(tmpdir(), "yazcode-migrate-"));
}

test("旧根存在时复制到 .yazcode（S1 起 sqlite 除外），旧根保留并写入标记", async () => {
  const { setDataBaseDir, migrateLegacyZCodeDataRoot, getZCodeDataRootDir } = await loadPaths();
  const base = makeBase();
  try {
    const legacy = join(base, ".zcode");
    mkdirSync(join(legacy, "v2"), { recursive: true });
    mkdirSync(join(legacy, "cli", "db"), { recursive: true });
    writeFileSync(join(legacy, "v2", "setting.json"), '{"marker":"legacy"}');
    writeFileSync(join(legacy, "cli", "db", "db.sqlite"), "db-bytes");
    setDataBaseDir(base);
    migrateLegacyZCodeDataRoot();
    const nextRoot = getZCodeDataRootDir();
    assert.equal(nextRoot, join(base, ".yazcode"));
    assert.equal(readFileSync(join(nextRoot, "v2", "setting.json"), "utf8"), '{"marker":"legacy"}');
    // S1（docs/specs/zcodium-data-root.md 行为规则 3 复制排除项）：sqlite 库不再
    // 跨产品复制——宿主库携带上游迁移账本，采纳外来账本会撞表阻断首装启动。
    assert.equal(existsSync(join(nextRoot, "cli", "db", "db.sqlite")), false);
    // 复制而非移动：官方 ZCode 客户端可能仍依赖旧根。
    assert.equal(existsSync(join(legacy, "v2", "setting.json")), true);
    assert.equal(existsSync(join(legacy, ".migrated-to-yazcode")), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("S1：宿主迁移账本库及 -wal/-shm 伴生全树排除，宿主数据不被触碰", async () => {
  const { setDataBaseDir, migrateLegacyZCodeDataRoot, getZCodeDataRootDir } = await loadPaths();
  const base = makeBase();
  try {
    const legacy = join(base, ".zcode");
    // 伪造宿主迁移账本（宿主 0004 与本仓 0004_projects 同号不同物，正是撞表根因）。
    const hostLedger = [
      "0001_adopt",
      "0002",
      "0003",
      "0004_project_execution_scopes",
      "0006_task_group_admissions",
    ].join("\n");
    mkdirSync(join(legacy, "v2"), { recursive: true });
    mkdirSync(join(legacy, "skills", "nested"), { recursive: true });
    writeFileSync(
      join(legacy, "v2", "tasks-index.sqlite"),
      `tasks_schema_migration\n${hostLedger}\n`,
    );
    writeFileSync(join(legacy, "v2", "tasks-index.sqlite-wal"), "wal-bytes");
    writeFileSync(join(legacy, "v2", "tasks-index.sqlite-shm"), "shm-bytes");
    writeFileSync(join(legacy, "skills", "nested", "another.sqlite"), "nested-db");
    writeFileSync(join(legacy, "skills", "nested", "keep.md"), "keep");
    setDataBaseDir(base);
    migrateLegacyZCodeDataRoot();
    const nextRoot = getZCodeDataRootDir();
    // sqlite 全树排除：顶层任务库 + WAL/SHM 伴生 + 嵌套库一律缺席。
    assert.equal(existsSync(join(nextRoot, "v2", "tasks-index.sqlite")), false);
    assert.equal(existsSync(join(nextRoot, "v2", "tasks-index.sqlite-wal")), false);
    assert.equal(existsSync(join(nextRoot, "v2", "tasks-index.sqlite-shm")), false);
    assert.equal(existsSync(join(nextRoot, "skills", "nested", "another.sqlite")), false);
    // 其余文件照常复制；staging 临时目录清理干净。
    assert.equal(readFileSync(join(nextRoot, "skills", "nested", "keep.md"), "utf8"), "keep");
    assert.deepEqual(readdirSync(base).sort(), [".yazcode", ".zcode"]);
    // 宿主原库不被触碰：账本行原样保留在 .zcode。
    const untouched = readFileSync(join(legacy, "v2", "tasks-index.sqlite"), "utf8");
    assert.ok(untouched.includes("0004_project_execution_scopes"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("用户删除新根视为重置：标记生效，不再重新灌入", async () => {
  const { setDataBaseDir, migrateLegacyZCodeDataRoot, getZCodeDataRootDir } = await loadPaths();
  const base = makeBase();
  try {
    const legacy = join(base, ".zcode");
    mkdirSync(join(legacy, "v2"), { recursive: true });
    writeFileSync(join(legacy, "v2", "x"), "x");
    setDataBaseDir(base);
    migrateLegacyZCodeDataRoot();
    rmSync(getZCodeDataRootDir(), { recursive: true, force: true });
    migrateLegacyZCodeDataRoot();
    assert.equal(existsSync(join(base, ".yazcode")), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("无旧根或新根已存在时为 no-op", async () => {
  const { setDataBaseDir, migrateLegacyZCodeDataRoot } = await loadPaths();
  const base = makeBase();
  try {
    setDataBaseDir(base);
    migrateLegacyZCodeDataRoot();
    assert.equal(existsSync(join(base, ".yazcode")), false);
    // 新根已存在时不被覆盖。
    mkdirSync(join(base, ".yazcode"), { recursive: true });
    writeFileSync(join(base, ".yazcode", "keep"), "keep");
    mkdirSync(join(base, ".zcode"), { recursive: true });
    writeFileSync(join(base, ".zcode", "legacy"), "legacy");
    migrateLegacyZCodeDataRoot();
    assert.equal(existsSync(join(base, ".yazcode", "legacy")), false);
    assert.equal(readFileSync(join(base, ".yazcode", "keep"), "utf8"), "keep");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("base 未显式设置时默认解析到 HOME（回归保护）", async () => {
  const { setDataBaseDir, getDataBaseDir } = await loadPaths();
  setDataBaseDir(null);
  assert.equal(getDataBaseDir(), process.env.HOME?.trim() || homedir());
});
