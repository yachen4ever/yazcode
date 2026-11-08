// sqlite schema 只增契约内核（docs/specs/sqlite-schema-contract.md）。
// 契约语义与上游 zai-org main@3c5b2276 的 scripts/sqlite-schema-contract.mjs 逐字对齐：
// 纯逻辑、无仓库依赖，供 scripts/check-sqlite-schema.ts 与 scripts/test/ 复用。
import { execFile as execFileCallback } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const identifier = (name) => `"${name.replaceAll('"', '""')}"`;
// 字符串中的 CHECK/括号不是约束，字面量大小写也不能随 SQL 关键字一起归一化。
function sqlTokens(sql) {
  return (
    sql.match(
      /--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[a-zA-Z_][a-zA-Z_0-9]*|\d+(?:\.\d+)?|[^\s]/g,
    ) ?? []
  )
    .filter((token) => !token.startsWith("--") && !token.startsWith("/*"))
    .map((token) => (/^[a-zA-Z_]/.test(token) ? token.toLowerCase() : token));
}
function checks(db, table) {
  const tokens = sqlTokens(
    db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table).sql,
  );
  const result = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== "check" || tokens[i + 1] !== "(") continue;
    const start = ++i;
    let depth = 0;
    do {
      if (tokens[i] === "(") depth++;
      if (tokens[i] === ")") depth--;
      i++;
    } while (i < tokens.length && depth > 0);
    result.push(JSON.stringify(tokens.slice(start, i)));
    i--;
  }
  return result.sort();
}
function automaticUniqueKeys(db, table) {
  return db
    .prepare(`PRAGMA index_list(${identifier(table)})`)
    .all()
    .filter((index) => index.origin === "u")
    .map((index) =>
      JSON.stringify(
        db
          .prepare(`PRAGMA index_xinfo(${identifier(index.name)})`)
          .all()
          .filter((column) => column.key)
          .map(({ name, desc, coll }) => ({ name, desc, coll })),
      ),
    )
    .sort();
}
export function dumpSqliteSchema(db) {
  const objects = db
    .prepare(
      "SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,name",
    )
    .all();
  return objects.map((object) => `${object.sql};`).join("\n\n") + "\n";
}

export function assertAdditiveSchema(beforeSql, afterSql) {
  const before = new DatabaseSync(":memory:");
  const after = new DatabaseSync(":memory:");
  try {
    before.exec(beforeSql);
    after.exec(afterSql);
    const oldTables = before
      .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all();
    for (const { name } of oldTables) {
      const oldColumns = before.prepare(`PRAGMA table_info(${identifier(name)})`).all();
      const newColumns = after.prepare(`PRAGMA table_info(${identifier(name)})`).all();
      if (!newColumns.length) throw new Error(`Removed table: ${name}`);
      if (JSON.stringify(checks(before, name)) !== JSON.stringify(checks(after, name)))
        throw new Error(`Changed CHECK constraints: ${name}`);
      if (
        JSON.stringify(automaticUniqueKeys(before, name)) !==
        JSON.stringify(automaticUniqueKeys(after, name))
      )
        throw new Error(`Changed UNIQUE constraints: ${name}`);
      for (const column of oldColumns) {
        const next = newColumns.find((value) => value.name === column.name);
        if (!next) throw new Error(`Removed column: ${name}.${column.name}`);
        for (const key of ["type", "notnull", "dflt_value", "pk"]) {
          if (column[key] !== next[key])
            throw new Error(`Changed column contract: ${name}.${column.name}.${key}`);
        }
      }
      for (const column of newColumns) {
        if (
          !oldColumns.some((value) => value.name === column.name) &&
          column.notnull &&
          column.dflt_value == null
        ) {
          throw new Error(`New required column has no default: ${name}.${column.name}`);
        }
      }
      const oldFks = before.prepare(`PRAGMA foreign_key_list(${identifier(name)})`).all();
      const newFks = after.prepare(`PRAGMA foreign_key_list(${identifier(name)})`).all();
      for (const key of oldFks) {
        if (
          !newFks.some((value) =>
            ["table", "from", "to", "on_update", "on_delete"].every(
              (field) => value[field] === key[field],
            ),
          )
        ) {
          throw new Error(`Changed foreign key: ${name}.${key.from}`);
        }
      }
    }
    for (const index of before
      .prepare(
        "SELECT name,sql FROM sqlite_schema WHERE type IN ('index','trigger') AND sql IS NOT NULL",
      )
      .all()) {
      const next = after.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(index.name);
      const normalize = (sql) => JSON.stringify(sqlTokens(sql));
      if (!next || normalize(next.sql) !== normalize(index.sql))
        throw new Error(`Removed or changed index/trigger: ${index.name}`);
    }
  } finally {
    before.close();
    after.close();
  }
}

async function hasCommit(run, ref) {
  try {
    await run("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * schema 只增约束必须与「目标分支」比较，不能用 HEAD（上游 ZCodium #90 maintainer
 * 加固同款回流，spec：docs/specs/sqlite-schema-contract.md 防篡改段）：
 * pre-push 在提交之后运行，HEAD 已包含新 baseline——「破坏性迁移 + 更新后 baseline
 * 同提交」会拿新 baseline 与新 schema 互比，校验静默通过。
 * 解析顺序：显式变量 → CI 目标分支变量 → origin/HEAD / origin/main 等候选的
 * merge-base；全部不可解析回退 HEAD 并由调用方显式告警。
 * run 注入便于测试（默认真实 git，cwd 由调用方决定）。
 */
export async function resolveSchemaBase({ env = process.env, cwd, run = execFile } = {}) {
  const exec = (cmd, args) => run(cmd, args, { cwd: cwd ?? process.cwd() });

  const explicit = env.SQLITE_SCHEMA_BASE_REF?.trim();
  if (explicit) {
    if (await hasCommit(exec, explicit)) {
      return { base: explicit, label: `explicit ${explicit}` };
    }
    console.warn(`[db:schema:check] ignore invalid SQLITE_SCHEMA_BASE_REF=${explicit}`);
  }

  const ciBase = env.CI_MERGE_REQUEST_DIFF_BASE_SHA?.trim();
  if (ciBase) {
    if (await hasCommit(exec, ciBase)) {
      return { base: ciBase, label: `CI ${ciBase}` };
    }
    console.warn(`[db:schema:check] ignore invalid CI_MERGE_REQUEST_DIFF_BASE_SHA=${ciBase}`);
  }

  const originHead = await exec("git", [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ])
    .then((result) => result.stdout.trim())
    .catch(() => "");
  const githubBase = env.GITHUB_BASE_REF?.trim();
  for (const ref of [originHead, githubBase ? `origin/${githubBase}` : "", "origin/main", "main"]) {
    if (!ref || !(await hasCommit(exec, ref))) continue;
    const mergeBase = await exec("git", ["merge-base", "HEAD", ref])
      .then((result) => result.stdout.trim())
      .catch(() => "");
    if (mergeBase) return { base: mergeBase, label: `merge-base ${ref}` };
  }
  return { base: "HEAD", label: "HEAD (未找到目标分支，destructive 变更不可检出)" };
}
