# 上游（zai-org/ZCode 3.16.2 / ZCodium 1.16.2）变更引入评估与任务书

> 产出背景：用户 2026-10-22 指令「zai-org/ZCode 已更新到 3.16.2，zcodium 也更新到 1.16.2，
> 做做调研有没有我们值得引入的正向改动」。
> 基准：上游 `zai-org/ZCode` main@`3c5b2276`（根版本 3.16.2），对比 yazcode main@`3a20692`（26.2.1）。
> 旁证：`ZCodium-project/ZCodium` v1.16.2（tag `ad118be3`，2026-10-22）——**它是 3.16.2 的发布工程分支**，
> 不是另一条产品线。
> 只读参考：`git fetch https://github.com/zai-org/ZCode.git main:refs/remotes/upstream-readonly/main --no-tags`
> 后 `git show refs/remotes/upstream-readonly/main:<path>`；**严禁在 yazcode 目录对上游执行 merge/pull**
> （2026-10-16 双仓误 pull 事故前科）。

## 版本号核实（先纠正一个可能的误解）

用户提到的两个版本号指向**同一批内容**，不是两个独立的改动集：

| 渠道 | 事实 |
| --- | --- |
| `zai-org/ZCode` GitHub releases | 只到 **v3.14.3**（2026-09-24）。**没有 v3.16.2 release** |
| `zai-org/ZCode` tags | 只到 **v3.15.1**（`aac47556`）。**没有 v3.16.2 tag** |
| `zai-org/ZCode` main 分支 `package.json` | `version: 3.16.2` ✅ |
| `zai-org/ZCode` main 提交线 | `872ad960`(open source) → `v3.14.3` → `v3.15.1` → `0a1fc56d`(10-19) → **`3c5b2276`(10-20, "sync ZCode source")** |
| `ZCodium-project/ZCodium` releases | **v1.16.2（2026-10-22）** ✅，其 `package.json` 为 `zcode@1.16.2` |

结论：**3.16.2 是上游主干版本号，尚无 tag/release**；ZCodium v1.16.2 是它的**发布工程分支**
（把上游 `3c5b2276` 同步过去，按 fork 的 1.y.z 体系发版）。所以「3.16.2 与 1.16.2 的正向改动」
= **同一批上游增量**，不必拆成两轮评估。

> 与 10-18 那轮（`docs/upstream-port-tasks-20261018.md`）的关系：那次基准是上游 main@`9cd5e0e4`。
> 本次基准 `3c5b2276` 相比它又前进了 3 个 commit（`aac47556` v3.15.1 再基线 + 两个 sync commit）。
> 本轮只报**增量**，不重复 10-18 已存档的结论。

## 结论（TL;DR）

**功能面没有需要立刻引入的东西**——上游 3.16.2 的 9 项增量已由自动审计
（`ZCodium-project/ZCodium` issue **#63**，范围 `0a1fc56d..3c5b2276`）逐条核对过，
结论均为「与本仓库独立版本体系 / 审计版裁剪交叉，不建议整体移植」（详见下方存档表）。

**真正值得引入的是上游的「工程治理基础设施」**——这正是我们 26.2.1 之后暴露的欠账所在：
上游 `verify:pre-push` 已把 **schema 契约、架构治理自测、上游准入、源码规模策略**四层
都纳入门禁，而我们的 `verify:pre-push` 只有 lint → 架构检查 → 技能残留 → 构建 → 类型检查 → 测试。
其中 **T1（架构治理自测 + 上游准入快照）与 T2（sqlite schema 只增契约）** 有独立价值、
工作量可控、且与我们的既有欠账直接咬合。

## 已核实「无需引入」清单（存档理由，后续会话不必重查）

| 上游项 | 判定 | 依据 |
| --- | --- | --- |
| 3.16.2 九项功能增量（托盘角标、Source Server 探针、`0007` 索引迁移、动态工作流选择、OAuth 多标签登录、Side Pane 完整视图、Composer/文件树/设置 UI、分屏下线、版本元数据） | **不建议引入** | 自动审计 issue #63 已逐条核对：与本仓库独立版本体系（1.y.z / 26.z）、审计版 UI 裁剪、保留的分屏功能交叉；上游分屏下线会打断我们的 `WorkspaceGroupedTasksSection` / `WorkbenchPane` |
| **vitest 全量迁移**（上游 `vitest.config.ts` + `test:unit` + `test:unit:affected` + `coverage`） | **暂不引入（可分阶段）** | 上游把全部单测迁到 vitest 单仓 runner，配套 `vitest.setup.ts`、13 个 alias、`projects` 分组、fork 隔离池。我们现有 9 个套件 372 用例跑在 `node:test` + `tsx` 上，**已全绿且已接入门禁**；迁移的收益是上游那 13 组 fork 隔离名单，而那份名单针对的是上游自己的 flaky 集，与我们的 372 用例无交集。**现在迁＝把绿门禁推倒重来，收益不对称** |
| 上游 `max-lines` 800 + 已接纳文件降级为 warning | **不采纳** | 我们的阈值是 **400**（`.oxlintrc.json`），比上游更严。上游的 800 是为它自己的大文件（`v4-gateway.ts` 等）放宽的，与我们无关 |
| `scripts/architecture/` 重构（`adopt` / `context` / `report` / `resolver` / `violations` / `upstream-admission` / `upstream-snapshot`） | **部分引入（见 T1）** | 我们已有 `architecture-check.mjs` / `index.mjs`(390 行) / `policy.mjs`(190 行) / `git-file-names.mjs`，覆盖模块边界检查。上游多出的是**治理脚本自身的自测**与**上游文件快照准入**，这两块我们没有 |
| 上游 `sqlite-schema-contract.mjs` + `check-sqlite-schema.ts` | **引入（见 T2）** | 我们有迁移机制但**无 schema 契约门禁**：`packages/services/src/session/tasksDatabase/migrations.ts` 与 `apps/zcode-cli/packages/adapters/src/storage/session-store/migrations/`（0020-0022）都能改结构而无门禁拦 |
| 上游 `license-identifiers.mjs` + `scripts/test/license-identifiers.test.mjs` | **不适用** | 我们 `scripts/licenses.mjs check` 已覆盖许可标识分类（且更严格：`check --strict` + `reviewRequired` 清单） |
| 上游 `cli-lint-admission.mjs` / `run-cli-lint.mjs` | **不引入（暂）** | 上游用它枚举各包 oxlint 脚本并对 `eslint(max-lines)` 在已接纳文件上降级。我们的 lint 口径已统一（`pnpm lint` 93 warnings / 0 errors），无「按包枚举」的必要 |
| 上游 `bootstrap-patched-dependencies.mjs` | **不适用** | 我们的 CLI 打包链是 `scripts/prepare-prebuilds.mjs` + `build-desktop-agent-cli.mjs`，与上游 bootstrap 装配不同构 |
| 上游 `run-affected-unit-tests.mjs` + `scripts/affected-unit-tests/*` | **不引入（暂）** | 上游用它做「按改动范围选测」以压缩全量门禁时长。我们的 `verify:pre-push` 已 190s（含冷启动 build），372 用例本身只占 21s；**增量选测是优化项，不是欠账**，且引入它等于给门禁开「按需跳过」的口子，与我们「失败即拦」的口径冲突 |
| 上游 `scripts/verify-project-upgrade.mts` | **不引入** | 上游用来验证「项目升级」链路；我们是独立发行版，无上游升级流程 |
| `apps/zcode-cli` 嵌套 `pnpm-lock.yaml` | **既成事实，不动** | 上游同样保留该文件，且同样**无法独立安装**（缺 `@zcode/model-option-map`）。实测我们那份已与 package.json 漂移 6/13 包，但**全仓无人安装它**（CI/release 都不装），上游也一样。这是上游遗留物，不是我们的欠账 |

## T1（建议立项）：架构治理脚本自测 + 上游文件准入快照

### 这是什么

上游把「治理脚本本身」也纳入测试，新增 4 个测试文件并挂进 `verify:pre-push`：

- `scripts/test/architecture-governance-review.test.mjs`（414 行）——审 `architecture-check.mjs`
  的判定逻辑本身（误报/漏报用例）。
- `scripts/test/architecture-upstream-admission.test.mjs`（163 行）——配合
  `scripts/architecture/upstream-admission.mjs` + `upstream-snapshot.json`：
  把上游 `.agents/skills/**` 等文件按 **git blob hash** 记档，**上游改了这些文件就必须重新
  显式评审**，而不是无声合入。
- `scripts/test/source-size-policy.test.mjs`（56 行）——守 `.oxlintrc.json` 的 `max-lines`
  阈值与「已接纳文件降级为 warning」白名单不被误改。
- `scripts/test/cli-lint-admission.test.mjs`（34 行）。

上游 `verify:pre-push` 的完整形态：
`lint && db:schema:check && test:architecture && architecture:check --changed && test:unit:affected --scope push`

我们当前形态：`lint && architecture:check --changed && check:skill-residue && build:cli && typecheck:cli && test`

### 为什么对我们有价值

1. **我们已经有 `architecture:check --changed`，但它自己没有被测过。** 治理脚本判错模块边界
   时，会错误地放行或拦截真实的跨域依赖——而我们**没有**任何测试能发现这件事。
   `architecture-governance-review.test.mjs` 正是补这个洞的。
2. **上游准入快照与我们的产品立场直接相关。** 我们是独立产品线，但**持续反向移植上游**
   （`.agents/skills/**` 的办公三插件、ai-elements、agent-browser 等都来自上游）。
   上游 snapshot 机制把「哪些上游文件可以无声更新、哪些必须人工评审」变成可执行门禁——
   这正好覆盖我们 `docs/upstream-port-tasks-*.md` 系列**靠人记**的那部分。
3. **可移植性高。** 上游这批脚本的输入是我们已有的：`scripts/architecture/policy.mjs` +
   `architecture-policy.yaml` + `.oxlintrc.json` 都已存在同名同构文件。

### 分期建议

1. **P1（先做，约 0.5-1 天）**：引入 `architecture-governance-review.test.mjs` 的**思路**，
   不是抄文件——我们先给自己的 `scripts/architecture/index.mjs`（390 行）补一组判定用例
   （模块 id 重复、根路径越界、跨层 import、豁免路径命中）。
   **必须先写我们自己的 spec**（AGENTS.md 铁律），产出 `docs/specs/architecture-governance-self-test.md`。
2. **P2（上游准入快照，约 1-2 天）**：引入 `upstream-snapshot.json` 概念，对我们真正
   反向移植过来的上游文件（`.agents/skills/**`、`packages/ui/src/components/ai-elements/**`）
   记 git blob hash 快照 + 评审标记。
   **注意**：我们的路径与上游不同，需按本仓库实际路径重建快照，不能直接拷上游的 json。
3. **P3（可选）**：`source-size-policy` 的思路——我们阈值 400 比上游严，但可以加
   「已接纳的大文件只降级为 warning」的白名单机制，避免未来要么超限要么机械拆分。

### 验收红线

- spec 先行；治理脚本的测试必须能在**故意改坏**治理脚本时**真的变红**（否则测了个寂寞——
  参照我们上一轮做测试门禁时用过的「注入失败用例 → 门禁退出码非 0」手法）。
- 不改 `architecture-policy.yaml` 的既有判定语义，只加自测。
- 不引入上游的 `upstream-snapshot.json` 文件内容（路径体系不同），只引入机制。

## T2（建议立项）：sqlite schema 只增契约门禁

### 这是什么

上游新增 `scripts/sqlite-schema-contract.mjs`（`assertAdditiveSchema` / `dumpSqliteSchema`）
与 `scripts/check-sqlite-schema.ts`，并挂进 `verify:pre-push`：

```
db:schema:check = node --test scripts/test/sqlite-schema-contract.test.mjs
                && pnpm --dir apps/zcode-cli exec tsx ../../scripts/check-sqlite-schema.ts
```

机制：对两个数据库（app 的 tasks-index、CLI 的 session-store）各存一份
**schema 基线**（`schema.baseline.sql`），每次检查时把当前实际 schema 与基线比对，
**只允许增列/增表，不允许删列或改约束**；要改结构必须显式 `--update` 刷新基线，
基线 diff 进 review。

### 为什么对我们有价值

我们**有迁移机制，但没有 schema 契约门禁**——这正是本次调研挖出的真实欠账：

| 库 | 迁移文件 | 现状 |
| --- | --- | --- |
| app tasks-index | `packages/services/src/session/tasksDatabase/migrations.ts` + `schema-v1.ts` + `provider-selection-v2.ts` + `official-glm-selection-v3.ts` | 无基线、无「只增」校验 |
| CLI session-store | `apps/zcode-cli/packages/adapters/src/storage/session-store/migrations/`（`0020` `0021` `0022`） | 同上 |

任务库是用户数据的落脚点。**一次「顺手改个列」就能静默破坏老会话的可读性**，
而我们目前没有任何自动化手段能发现这件事——只有用户报障。上游这套门禁正是针对这个风险。

### 与上游的差异（移植时必须处理）

上游的 `check-sqlite-schema.ts` **不能直接抄**，它 import 了我们没有的路径：
- `packages/shared/src/sqlite-migrations/index.js`（上游独有）
- `apps/zcode-cli/packages/adapters/src/storage/session-store/migrations.js` 的 `SQLITE_MIGRATIONS` 导出形态与我们不同

我们要**按本仓库的迁移结构重写**驱动脚本，复用上游的**契约内核**
（`assertAdditiveSchema` / `dumpSqliteSchema`，两个文件、纯逻辑、可直接借鉴）。

### 分期建议

1. **P1（0.5 天）**：引入契约内核 + 单元测试（上游 `sqlite-schema-contract.test.mjs` 76 行，
   逻辑自洽，可直接借鉴并按我们的断言风格改写）。
2. **P2（1 天）**：按我们的两个库写基线生成器与检查脚本，产出
   `packages/services/src/project-storage/schema.baseline.sql`（或按我们实际的库路径命名）
   与 CLI 侧的对应基线。
3. **P3**：挂进 `verify:pre-push`（上游是 `db:schema:check`）。

### 验收红线

- 基线文件必须由**实际迁移产物**生成，不得手写（手写基线 = 没有基线）。
- 检查必须在**干净检出**上可跑（当前 `verify:pre-push` 已前置 `build:cli`，基线生成依赖 dist 产物要注意顺序）。
- 故意改坏一次迁移（删列）→ 检查必须变红。

## 明确不做

- **不做 vitest 全量迁移**（见存档表）：现有 `node:test` + `tsx` 门禁已全绿并接入 CI，
  迁移收益（上游那 13 组 fork 隔离名单）与我们无关，风险不对称。
- **不整体再基线吸收上游 3.16.2**：延续 10-18 的决策——独立产品线不追与上游同源。
- **不引入上游的 `max-lines` 800 放宽**：我们的 400 更严。
- **不引入上游 `run-affected-unit-tests` 的按需选测**：给门禁开口子，与「失败即拦」冲突。
- **不动 `apps/zcode-cli/pnpm-lock.yaml`**：上游同样保留且同样不可独立安装，无人使用。

## 与本轮 ① 修复的关系

本轮同时修掉了上一轮调研挖出的 ①（CLI 子包在嵌套 workspace 下 `tsx` 不可解析）。
查因过程中确认：**上游不存在这个问题，因为上游 CLI 子包的 test 脚本用 `vitest`**，
且 `vitest` 由各包自己的 `devDependencies` 声明（`@zcode/core`、`@zcode/adapters` 均含
`"vitest": "^4.1.5"`）——上游从不在脚本里裸调一个未声明的二进制。

我们的修法**不是**补 devDependency（实测无效：pnpm 不为嵌套 workspace 的成员建独立依赖树，
`apps/zcode-cli/packages/core/node_modules` 里连 `cheerio` 这类直接依赖都没有），
而是把脚本从 `tsx --test` 改成 `node --import tsx --test`——走 **Node 模块解析**而非
**PATH 二进制**，在根与嵌套两种上下文下都成立。详见 `docs/specs/test-gate-integration.md`。

这也是 T1/T2 之外**第三条上游启示**：上游「工具声明与用法一致」的纪律，
在我们这边是靠「先复现、再归因到加载器引入方式」才拿到的。
