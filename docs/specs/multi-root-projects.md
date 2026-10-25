# Spec：多目录项目（multi-root projects）

2026-10-25 用户拍板引入（`docs/upstream-port-tasks-20261025.md`），作为下一次 **y 位批次**
的主体。参考实现：ZCodium v1.17.0（数据模型在 #64 `06e0b728` 落库、接线在 `b0de1476`，
经 `zcodium-readonly/main` 只读分析）。本 spec 按 yazcode 现状重定契约，不做整体再基线。

## 现状与术语

yazcode 目前**没有项目实体**：侧栏「项目」只是按 workspace 路径分组的任务视图
（`packages/ui/src/workspace-grouped-tasks/`），设置里有 `recentProjects: string[]`
（`packages/shared/src/validationAppSettings.ts`）。本 spec 引入 **project 实体**：
一个项目 = 名称 + 有序 roots 列表 + 其中一个 primary root。

## 数据契约（P1）

- 落库在 **tasks-index.sqlite**（`packages/services/src/session/tasksDatabase/`），新表
  `projects(project_id PK, name, host_id, …)` 与 `project_roots(project_id, root_path,
  position, is_primary, PK(project_id, root_path))`——只增建表，受
  `docs/specs/sqlite-schema-contract.md` 门禁保护。tasks 表增列 `root_path` /
  `project_id` / `execution_directories`（可空，存量行为不变）。
- **primary 唯一性**由保存路径保证：`saveProject` 单事务 `DELETE project_roots` + 重插
  （ZCodium 同型，无增量 UPDATE 分支）。
- 存量迁移：首次建 project 表时从 `settings.recentProjects` 每路径建一个单 root 项目
  （首个 root 自动 `is_primary=1`），一次性、幂等（已存在同名同路径则跳过）。yazcode
  没有 ZCodium 的 `lastWorkspaceSession` 结构，迁移来源以本仓 settings 为准。
- 任务行 `root_path/execution_directories` 只在**任务首发前 reserve 一次**；此后改项目
  主目录、增删 roots 均不改写已存在任务（cwd 读任务自身行，不读项目当前主目录）。

## 会话契约（P1/P2）

- 新任务 cwd = 项目 **primary root**；primary 在文件系统上缺失时**拒绝创建**
  （`project.primary-root-missing`），不静默 mkdir 复活、不回落其他 root。
- `additionalDirectories` = 其余 roots（有序、去重、排除 cwd 自身）。
- 贯穿三条通道（ZCodium 同构，按本仓协议重建）：session **create**、session **resume**、
  **V4 冷恢复**——冷恢复由 Host 重解析（`resolveSessionDirectories` 读任务行固化值，
  缺失再按项目当前 roots 补），CLI 侧继承仅限**派生运行时**（workflow / 子代理）。
- 协议字段进 `packages/shared/src/zcode-protocol/index.ts`：`additionalDirectories`
  `max 256` 项、每项非空。

## 信任边界（P2，产品裁决）

`additionalDirectories` 在 CLI 侧是**白名单接线**，只允许进入：

1. skills 发现（`apps/zcode-cli/packages/adapters/src/skills/roots.ts`）
2. 自定义命令发现（`commands/roots.ts`）
3. 子代理发现（bootstrap 侧等价物）
4. Environment Info 段展示

同名能力以 `namespace = basename(目录)` 限定来源。**禁止**把附加目录接入
config/AGENTS/MCP/hooks/plugins/memory/permissions 的装配——这些仍只沿
`workingDirectory` 链（上游 `runtime-config.ts` 同语义，注释即契约）。审计验收：
`additionalDirectories` 标识符在 CLI 侧的引用点必须逐个对应上述白名单。

## 远程边界（P4）

SSH / Source Server 项目**硬约束单 root**：保存、root 初始化、任务迁移、reserve 四个
入口全部强制 `roots.length === 1` 且远端 root 不可改（`project.remote-single-root-required`
/ `project.remote-root-immutable`）；远端会话 `additionalDirectories` 一律为空。
参考实现 `remote-policy.ts`（约 40 行零依赖）原样移植。

## UI 契约（P3）

- 项目编辑器：本地经系统多选（`IPlatformService` 目录选择）、继续添加、去重（UI 与
  Repository 双层）、移除、改名、设置主目录；主目录被移除时回落首个 root。
- 文件提及（@）：对 `[cwd, ...roots]` 逐 root 搜索、按绝对路径去重、`rootName`
  （basename）标注来源；非 cwd root 的提及用**绝对路径**引用，cwd 用相对路径。
- 草稿隔离：composer 草稿按 `{clientNamespace, hostId, projectId}` 复合键存储，
  同 cwd 的不同项目不串草稿。
- 迟到防护：编辑器保存/浏览的异步回执以 epoch/alive 失效（卸载或换代即丢弃）。

## 不做（本批次范围外）

- 手机 paired project bridge、`mobileTaskView` 协议（ZCodium 侧亦未完成授权入口）。
- 随 v1.17.0 搭车的 Gen UI 交互式/插件后台事件、Source Server 管理 UI。
- 远程多 root。

## 分期

| 期 | 内容 | 交付物 |
| --- | --- | --- |
| P1 | 数据层 + Host 项目服务（CRUD、prepareSession、任务 reserve 固化） | 表 + 迁移 + 服务 + 单测（schema 门禁随行） |
| P2 | 协议字段 + CLI 白名单消费（三条通道 + 发现点 + env-info） | 协议 schema + CLI 注入点 + 信任边界审计测试 |
| P3 | UI（编辑器、侧栏项目化、文件提及、草稿隔离） | 组件 + 交互测试 |
| P4 | 远程单 root 边界 + 自动化/闲时任务携带 projectId/hostId | remote-policy + 调度归属 |

P1 未验收不启动 P2；P2 的信任边界审计未过不启动 P3。

## 验收场景

1. 建双 root 项目并发起任务：cwd = primary，附加目录进 skills/commands 发现且带
   namespace；同名技能两个 root 并存、来源可辨。
2. 改主目录 / 移除 root 后：旧任务 cwd 与已固化附加目录不变；新任务用新主目录。
3. primary 目录被删：新任务创建被拒并提示，不复活目录。
4. `additionalDirectories` 不出现在任何配置装配入参（审计断言）。
5. 远程项目保存双 root 被拒；远程会话附加目录为空。
6. sqlite schema 门禁：新增表/列经 `db:schema:update` 显式入基线，无删改。
7. 同 cwd 双项目：草稿、文件提及来源标注、任务归属各自独立。
