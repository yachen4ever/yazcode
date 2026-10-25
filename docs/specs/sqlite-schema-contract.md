# Spec：sqlite schema 只增契约门禁

任务书 `docs/upstream-port-tasks-20261022.md` T2。上游（zai-org main@`3c5b2276`）把
`sqlite-schema-contract.mjs`（契约内核）+ `check-sqlite-schema.ts`（驱动）挂进
`verify:pre-push` 的 `db:schema:check`；本仓按同一契约语义、按自身迁移结构重写驱动
（上游驱动 import 的 `packages/shared/src/sqlite-migrations` 本仓不存在，不可直接抄）。

## 覆盖对象与入口

| 库                                    | 迁移声明                                                                                                      | 驱动建库方式                                                                                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| app tasks-index（用户任务数据落脚点） | `packages/services/src/session/tasksDatabase/migrations.ts`                                                   | `TaskIndexRepo` / `AutomationRepo` / `OffPeakTaskRepo` 以**显式临时 dbPath** 构造并 `ensureReady()`（不经过全局 `setDataBaseDir`，规避其并发覆盖隐患），对产出的 sqlite 文件 dump schema |
| CLI session-store                     | `apps/zcode-cli/packages/adapters/src/storage/session-store/migrations.ts`（`SQLITE_MIGRATIONS` 纯 SQL 数组） | 内存库按迁移账本顺序逐条 `exec`（含 `schema_migration` 账本表，DDL 与 migration-runner 逐字一致），dump schema                                                                           |

基线文件（各一份，均由 `--update` 从**实际迁移产物**生成，禁止手写）：

- `packages/services/src/session/tasksDatabase/schema.baseline.sql`
- `apps/zcode-cli/packages/adapters/src/storage/session-store/schema.baseline.sql`

## 契约（只增语义，内核 `assertAdditiveSchema(before, after)` 逐条判定）

对旧 schema 中已存在的每张表：

1. **表不可删除**；列不可删除，且 `type / notnull / dflt_value / pk` 四项不可变更。
2. **CHECK 约束不可增删改**（SQL token 级归一化比对，字符串字面量大小写不参与归一化）。
3. **自动 UNIQUE 约束**（表定义内 UNIQUE，含列序 / DESC / collation）不可增删改。
4. **外键不可删除或变更**（table/from/to/on_update/on_delete 逐字段比对）。
5. 索引与触发器：旧有名目必须仍在且 token 归一化后等价；**新增允许**。
6. 新表、新列允许；但**新增 NOT NULL 列必须带 DEFAULT**（否则老数据行无法回填）。

## 防篡改与更新流程

- 比对基准取 `git show ${base}:<baseline>`（base = `CI_MERGE_REQUEST_DIFF_BASE_SHA` ||
  `SQLITE_SCHEMA_BASE_REF` || `HEAD`）：**手改工作区基线不能绕过只增约束**——相对上次
  提交的 schema 演化仍须只增。首次引入基线时无历史文件，跳过该方向。
- 检查态还要求工作区基线与当前 schema **逐字节一致**：不一致即要求显式
  `pnpm db:schema:update` 重生成、diff 进 review，杜绝「基线悄悄过期」。
- `--update` 永远从真实迁移产物写基线；schema 破坏性变更的合入路径 = 先修迁移、
  `--update` 刷新基线、review 时基线 diff 显式呈现删改。

## 门禁接入点

- `verify:pre-push`：`lint → architecture:check → check:skill-residue → db:schema:check → build:cli → typecheck:cli → test`。
- CI `tests.yml` 与本地同口径，push/PR 都跑 `pnpm run db:schema:check`。
- 契约内核的单测（`scripts/test/sqlite-schema-contract.test.mjs`）经既有 `test:scripts`
  glob 进入根 `pnpm test`，不重复挂在 `db:schema:check` 里。
- 许可台账不受影响：`inventory.inputs` 只登记既有 3 个 scripts 文件，本门禁脚本不进入。

## 验收场景

1. 干净检出：`pnpm run db:schema:check` 绿（基线与迁移产物逐字节一致、双向只增）。
2. 迁移被改坏（如删列 / 删索引 / 新增无默认值的 NOT NULL 列）：检查变红并指明具体
   违约项。
3. 手改工作区基线以「配合」破坏性 schema：仍变红（git base 方向拦截）。
4. 合法新增（加表 / 加带默认值列 / 加索引）：`--update` 刷新基线后检查转绿，基线 diff
   进 review。
5. `pnpm typecheck` / `pnpm lint` / `pnpm fmt:check`（新文件单独）/ 全量门禁通过。

## 与上游的差异（移植时已处理）

- 不引入 `packages/shared/src/sqlite-migrations`；CLI 侧直接顺序执行 `SQLITE_MIGRATIONS`
  的 SQL，账本表 DDL 取自本仓 `migration-runner.ts` 原文。
- app 侧不用 `setDataBaseDir(tmpdir)`（上游做法），改为构造参数显式注入临时库路径：
  本仓 Repo 注释明确记录过全局 `_dataBaseDir` 在并发测试下的覆盖污染史，且
  `setDataBaseDir` 在 `ZCODE_DATA_BASE_DIR` 环境覆盖生效时是 no-op。
- 基线位置按本仓目录结构（上游放 `project-storage/`，本仓任务库迁移在 `tasksDatabase/`）。
