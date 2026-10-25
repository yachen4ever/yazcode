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

### 协议三通道（P2）

三处 schema 均为 strict zod，字段同形：`additionalDirectories?: string[]`，
`array`、`max(256)`、每项 `trim().min(1)`（非空 trimmed string），均可选、缺席即无附加目录：

1. **session create**（`zcodeSessionCreateParamsSchema`）——新任务首发由 Host 在
   `createTask` 的 session create 载荷下发（来源与 cwd 覆写同一份 `prepareSession` 产物）。
2. **session resume**（`zcodeSessionResumeParamsSchema`）——旧协议恢复路径由 Host 经
   `resolveSessionDirectories` 解析后下发。
3. **V4 冷恢复**（`v4ConversationSubscribeParamsSchema` 的 `additionalDirectories`，与
   `resumeThoughtLevel` 同族的 host→CLI 恢复 hint，live 订阅不消费）——Host 在
   `subscribeConversationV4` 读任务行（projectId/rootPath/executionDirectories）经
   `resolveSessionDirectories` 解析；解析失败降级为不下发（会话仍可恢复，附加目录缺席），
   不阻塞冷恢复。旧 CLI strict schema 不认 create/resume 的新字段时沿用既有
   omittedFields 兼容重试；v4 subscribe 与 `resumeThoughtLevel` 同策略（无握手协商，
   Host/CLI 同包发版）。

### 冷恢复语义（P2）

- Host 重解析优先级：任务行固化值（`rootPath` + `executionDirectories`）优先；
  固化值缺失时按项目当前 roots 现算。`resolveSessionDirectories` 是唯一解析器。
- CLI 收到 `additionalDirectories` 后注入 runtime（`AgentRuntimeConfig`），派生运行时
  （workflow child / subagent child）随 runtimeConfig 继承；CLI 自身不从磁盘重查项目。

## executionDirectories 空数组语义（L1 收敛，P2）

P1b-2 复核遗留（L1）：两处解析器空值语义分叉 + 写路径空数组落列形态需要定死。
本 spec 为唯一权威，本期收敛为：

- **「空数组」= 任务行固化了「显式空」**（单 root 项目 reserve 的产物），与
  「无固化值」（列 `null`、meta 缺字段）是两种状态。
- **写路径**：`meta.executionDirectories` 为 `undefined` → 列 `null`；为 `[]`（JS truthy）→
  列 `"[]"`。meta_json 始终保留原值（含 `[]`）。
- **读路径**：以 meta_json 为准、列做兜底（cron/off-peak/projectId 同款策略）。两处解析器
  （`taskIndexRepo.parseExecutionDirectoriesColumn` 与
  `projectService.parseExecutionDirectories`）语义逐条对齐：
  - 非字符串 / 空白串 / 非数组 JSON → 无固化值（`undefined` / `null`）；
  - 数组 → 过滤非字符串与 trim 后为空的项，**空数组原样返回**（不折叠成无固化值）。
- **行为差异锚点**：冷恢复 `resolveSessionDirectories` 中，固化值为 `[]` 时
  `fromTaskRecord: true` 且附加目录为空——不回落项目当前 roots（改项目 roots 不改写
  旧任务契约在单 root 项目上同样成立）。列兜底行（meta_json 缺失/非法）上 `"[]"` 亦
  解析为显式空。
- P1b-2 时点行为（列兜底把 `"[]"` 折叠成无固化值）由本期测试显式替换并锁定。

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

### CLI 侧消费点清单（P2 实装）

| 消费点        | 文件                                                            | 形态                                                                                                                                                                 |
| ------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| skills 发现   | `apps/zcode-cli/packages/adapters/src/skills/roots.ts`          | 每附加目录追加 `.zcode/skills` 与 `.agents/skills` project 根，root 带 `namespace = basename`；同名技能经 `qualifiedName = "<namespace>:<name>"` 可辨                |
| commands 发现 | `apps/zcode-cli/packages/adapters/src/commands/roots.ts`        | 每附加目录追加 `.zcode/commands` 与 `.agents/commands` project 根（含 `namespace` 元数据）；同名命令 cwd 优先（先到先赢不变），附加目录侧重复项落既有 duplicate 诊断 |
| 子代理发现    | `apps/zcode-cli/packages/bootstrap/src/subagents.ts`            | 每附加目录追加 `.zcode/agents` project 根；来自附加目录的 profile 名做 `<namespace>:<name>` 前缀（与插件 agent 同机制），project 级 permissionMode 剥离同款生效      |
| env-info 展示 | `apps/zcode-cli/packages/core/src/context/sections/env-info.ts` | `EnvInfo.additionalDirectories` 渲染 Additional working directories 段                                                                                               |

传输载体：`AgentRuntimeConfig.additionalDirectories`（core，注释即契约）是 CLI 侧唯一
runtime 冻结位——skills/commands/subagents/env-info 四个消费点只从它读；派生运行时随
runtimeConfig 继承。协议侧附加目录只在 create/resume/冷恢复三条通道的 record 装配处进入
runtimeConfig，**不触碰** `resolveAppRuntimeConfig` 里 config/MCP/hooks/plugins/memory/
permissions 的任何装配分支。

审计验收（场景 4，2026-10-25 按复核 M3 建议 1 升级为流动级口径）：词法断言——静态扫描
CLI 侧（apps/zcode-cli，.ts/.tsx/.mjs）全部 `additionalDirectories` 标识符引用点，逐个
断言落在上述四个消费点 + 协议/schema/类型接线位；任何指向
config/MCP/hooks/plugins/memory/permissions 装配的引用即测试失败（防越期接线）。
词法「零引用」不构成信任边界证明（上游与本项目都以整体展开方式在装配出口携带该值，
差别只在词法可见性），故在词法断言之上追加**流动级断言**：真实调用
`resolveAppRuntimeConfig`（config/MCP/hooks/plugins/memory/permissions 的唯一装配入口），
断言 ① 配置装配面对象（`configResult.config`）在调用前后逐字不变且不含
`additionalDirectories`；② 装配出口 `runtimeConfig` 键集合与快照相等（新增装配键须显式
更新快照，防静默扩面）；③ 附加目录只经 `AgentRuntimeConfig.additionalDirectories` 唯一
冻结位进入 runtime，入参缺席时出口不得无中生有。动态断言需先构建 CLI 包
（verify:pre-push 与 CI 的 test 阶段均先跑 `build:cli`）。

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

| 期  | 内容                                                              | 交付物                                      |
| --- | ----------------------------------------------------------------- | ------------------------------------------- |
| P1  | 数据层 + Host 项目服务（CRUD、prepareSession、任务 reserve 固化） | 表 + 迁移 + 服务 + 单测（schema 门禁随行）  |
| P2  | 协议字段 + CLI 白名单消费（三条通道 + 发现点 + env-info）         | 协议 schema + CLI 注入点 + 信任边界审计测试 |
| P3  | UI（编辑器、侧栏项目化、文件提及、草稿隔离）                      | 组件 + 交互测试                             |
| P4  | 远程单 root 边界 + 自动化/闲时任务携带 projectId/hostId           | remote-policy + 调度归属                    |

P1 未验收不启动 P2；P2 的信任边界审计未过不启动 P3。

## 验收场景

1. 建双 root 项目并发起任务：cwd = primary，附加目录进 skills/commands 发现且带
   namespace；同名技能两个 root 并存、来源可辨。
2. 改主目录 / 移除 root 后：旧任务 cwd 与已固化附加目录不变；新任务用新主目录。
3. primary 目录被删：新任务创建被拒并提示，不复活目录。
4. `additionalDirectories` 零流动（2026-10-25 口径升级）：不写回任何配置装配面对象、
   不出现在 MCP/hooks/plugins/memory/permissions 装配产物；装配出口键集合与快照相等，
   唯一进入 runtime 的形态是 `AgentRuntimeConfig.additionalDirectories` 冻结位
   （流动级审计断言 + 词法白名单双保险）。
5. 远程项目保存双 root 被拒；远程会话附加目录为空。
6. sqlite schema 门禁：新增表/列经 `db:schema:update` 显式入基线，无删改。
7. 同 cwd 双项目：草稿、文件提及来源标注、任务归属各自独立。
