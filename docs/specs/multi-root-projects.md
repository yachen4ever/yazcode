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
   omittedFields 兼容重试；**v4 subscribe 无降级路径**：基 schema 为 strict，旧 CLI 收到
   `additionalDirectories`/`resumeThoughtLevel` 等新字段时**整条 subscribe 解析失败**
   （不是「降级为不下发附加目录」），与 `resumeThoughtLevel` 完全同型（无握手协商）。
   「Host/CLI 同包发版」只在打包态桌面路径成立；两条独立部署路径存在真实错版窗口——
   `ZCODE_AGENT_SERVER_COMMAND` 环境覆盖与远端 SSH 已部署的 native binary（见
   `zcodeAgentProcessManager` 的命令解析顺序）。v4 subscribe 参数 schema 收紧或新增
   字段时，须按协议契约显式评估这两条错版路径（2026-10-25 复核 m3-3 措辞纠正）。

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

### P3 总则（状态所有者与身份口径）

- **项目事实的唯一持久所有者是 ProjectRepository（tasks-index.sqlite）**，经
  `IProjectService` 暴露。UI 侧任何项目状态都是它的**派生读模型**：Zustand
  `projectStore` 只缓存 `listProjects()` 快照并提供显式 refresh，不落盘、不接收
  远端广播（项目当前没有跨端同步面）；编辑器保存/删除成功后以服务返回的
  `ProjectRecord` 就地更新缓存，不重放写路径。不得出现第二份持久项目事实。
- **workspace 身份口径沿用全局统一键** `workspaceIdentity?.trim() || workspacePath`
  （AGENTS.md「Workspace Identity」）。多 root 会话的 workspaceKey 天然落
  primary root（P1b-2 语义），侧栏分组、去重、绑定一律按该键，不另起炉灶。
- **workspace → project 的呈现层关联是纯派生**：`project.primaryRoot === workspacePath`
  （本地单 host）即视为该 workspace 的项目上下文。同 cwd 双项目时呈现层取
  pinned 优先、创建时间次之的**确定性选择**，仅用于标注与 roots 提示；任务归属
  仍以任务行固化的 `projectId` 为准（见 G1 缺口）。
- **远端 workspace（remoteSessionId / workspaceIdentity 非空）**：P4 单 root 约束
  未落地前，呈现层不得假设远端永远单 root——项目标注与 roots 提示对远端 tab 同样
  生效（按 primary root 匹配）；项目编辑器对远端 workspace 不提供入口（P4 收口）。
- **迟到防护**：编辑器保存/删除、目录选择的异步回执一律以 epoch/alive 失效
  （卸载、对话框换代、目录响应晚于下一次交互即丢弃），不用超时掩盖竞态。

### P3a 状态底座

- `projectStore`（Zustand，内存态）：`projects: ProjectRecord[]`、`status`
  （idle/loading/ready/error）、`load()`（幂等单飞）、`refresh()`、`upsert(record)`、
  `remove(projectId)`。唯一写入口是 `IProjectService` 的返回值；store 不生成 projectId、
  不改写 roots。
- `resolveProjectForWorkspacePath(projects, workspacePath)` 纯函数：按 primary root
  匹配返回唯一项目或 null；同 cwd 多项目按 pinned 优先、`projectId` 字典序兜底，
  保证同输入同输出。
- 验收：store 不持久化（无 localStorage/SQLite 写点）；同 cwd 双项目解析确定性可测。

### P3b 项目编辑器（ProjectEditorDialog）

- 行为：新建（名称默认取首个 root 的 basename，可改名）与编辑（改名、增删 roots、
  设置主目录、删除项目）共用一个对话框。目录选择走 `IPlatformService.selectDirectory()`
  **单选 + 继续添加**（yazcode 平台面当前无系统多选；spec 以单选为准，多选是后续平台
  增强而非 P3 阻塞项）。添加时按绝对路径去重（UI 层先去重，Repository 层兜底）；
  移除主目录时主目录回落首个 root；roots 清空即禁用保存。
- 保存经 `projectService.saveProject({ name, roots, primaryRoot })`（编辑时带
  `projectId`）；删除经 `projectService.deleteProject`，删除前必须确认；删除只解绑
  组织归属，不触碰文件与任务。
- 状态所有者：对话框内表单态（name/roots/primary）是组件局部 state；提交成功后以
  服务返回记录更新 projectStore。错误直显服务错误码文案（`project.roots-empty` 等
  映射 i18n）。
- 验收：主目录被移除回落首个 root；双去重；保存后侧栏同名即时刷新（同一 store）；
  关闭对话框后迟到的保存回执不弹错。

### P3c 侧栏项目化

- 「项目」分区在现有 workspace tab 列表上**叠加项目标注**，不重建列表结构：
  - 行标题优先显示项目名（primary root 匹配），无匹配项目回落原路径 leaf；
    行内追加 roots 数徽标（>1 时显示，tooltip 列出全部 roots）。
  - 行上下文菜单新增「编辑项目」（该 workspace 有匹配项目时），打开 P3b 编辑器；
    「添加项目」菜单新增「新建项目」入口（无匹配项目时也始终可用）。
  - 任务分组仍按 workspaceKey（= primary root）展开，遵循 P1b-2 口径；任务行
    `projectId` 存在且与行项目一致时任务归属以任务行为准（现状即同 bucket）。
- 展开态、拖拽排序等既有偏好不动；远端 tab 只标注不提供编辑入口。
- 验收：同 cwd 双项目时侧栏显示确定性项目名（P3a 规则）；改名后侧栏即时更新；
  手机远控（web replayable）下侧栏降级可用（无项目匹配时回落路径 leaf，不报错）。

### P3d 文件提及跨 roots + 草稿隔离

- 文件提及（@）：对 `[workspacePath, ...additionalRoots]` 逐 root 调用
  `fileService.searchWorkspaceFiles`（该服务面接受任意 rootPath，P2 后无需新协议），
  按**绝对路径**去重（cwd 命中优先）；非 cwd root 的命中以 `rootName`（basename）
  标注来源，引用用**绝对路径**；cwd 命中沿用相对路径。additionalRoots 来源：
  - 草稿/新任务：workspace 匹配项目的当前 roots（排除 workspacePath）；
  - 已有会话：任务行固化 `executionDirectories` + `rootPath`（改项目 roots 不改写
    旧任务的提及范围），任务行缺固化值时回落项目当前 roots。
  - 附加 root 的搜索失败（目录缺失/权限）降级为该 root 静默缺席，不阻塞 cwd 搜索。
- 草稿隔离：v4 composer 草稿持久化键从 `workspaceKey` 扩展为
  `workspaceKey + projectId 段`（仅当草稿归属项目时）；无项目上下文回落原键，
  存量草稿（无项目段）继续可读。**正式 session 的后续草稿仍按
  workspace + sessionId 存取，不改为按项目存储**（ZCodium 同语义）。Recent/默认配置
  不在 P3 改键。
- 提交链路：桌面 v4 草稿首发当前无法携带项目归属（G1）；composer 在有项目上下文时
  仅消费项目 roots（提及、草稿键）与项目名展示。已支持 `projectId` 的
  `createTask` 面（replayable facade / automation / off-peak）语义不变。
- 验收：同 cwd 双项目草稿互不串；附加 root 文件可被 @ 命中且标注来源；附加 root
  目录被删后 @ 面板仍可用（cwd 命中不受影响）。

### G1 协议缺口登记（桌面 v4 草稿路径的项目归属，P3 不实施）

桌面 v4 草稿路径不经 `createTask`：预热走 v4 `createSession` 命令，任务行由
syncer 首次快照同步落库（`buildMetaFromSnapshot` 无项目字段），v4
`createSession`/`sendText` 载荷也没有 projectId 通道。因此**桌面首发任务当前无法
在创建边界固化 projectId/rootPath/executionDirectories**；replayable facade、
automation、off-peak 走 `createTask` 的路径不受影响（P1/P2 已接线）。

修复设计（留待独立小期，非本批）：仿 `clientMode` 先例
（`ZCodeAgentConversationCommandParams` 的 host 内部字段，不进 v4 wire envelope），
在 conversation command 参数上加 host 内部 `projectContext`；Host 在 createSession
ACK 后经 `prepareSession` 解析三件套，由 syncer 首写盖章（merge-preserve 已兜底保全）。
UI 侧 P3 已按此预留：composer/侧栏的项目上下文解析、草稿键、roots 消费均已就位，
补通道时只需在预热派发处多传一个字段。

## 不做（本批次范围外）

- 手机 paired project bridge、`mobileTaskView` 协议（ZCodium 侧亦未完成授权入口）。
- 随 v1.17.0 搭车的 Gen UI 交互式/插件后台事件、Source Server 管理 UI。
- 远程多 root；远端项目编辑入口（P4 与 remote-policy 一起收口）。
- `IPlatformService` 系统目录**多**选（P3 以单选 + 继续添加交付）。

## 分期

| 期  | 内容                                                              | 交付物                                      |
| --- | ----------------------------------------------------------------- | ------------------------------------------- |
| P1  | 数据层 + Host 项目服务（CRUD、prepareSession、任务 reserve 固化） | 表 + 迁移 + 服务 + 单测（schema 门禁随行）  |
| P2  | 协议字段 + CLI 白名单消费（三条通道 + 发现点 + env-info）         | 协议 schema + CLI 注入点 + 信任边界审计测试 |
| P3  | UI（状态底座 → 编辑器 → 侧栏项目化 → 提及 + 草稿隔离）           | 组件 + 交互测试 + G1 缺口登记               |
| P4  | 远程单 root 边界 + 自动化/闲时任务携带 projectId/hostId           | remote-policy + 调度归属                    |

P1 未验收不启动 P2；P2 的信任边界审计未过不启动 P3；P3 的 G1 通道补齐不阻塞 P4。

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
