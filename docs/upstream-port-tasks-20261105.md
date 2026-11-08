# 上游引入评估：ZCodium v1.17.1 → v1.17.4 + zai-org 主干增量（2026-11-05）

调研方式：只读 ref 比对（`git fetch --no-tags` 到 `refs/remotes/zcodium-readonly/*` /
`refs/remotes/upstream-readonly/*` + `git show`/`git log`，未 merge/pull/checkout，
未动工作区）。基线：本仓 main `7c2df4a6`（26.5.2 已发布 + F1–F7 修复批次合入）；
上轮审计终点 ZCodium v1.17.1（`ddae5a05`）/ zai-org 3.16.2（`3c5b2276`）。

## 上游动态

- **ZCodium 发布 v1.17.2 / v1.17.3 / v1.17.4**（主干 HEAD `0e88f6ec` = merge
  release/1.17.4），`ddae5a05..main` 共 37 commits（非 merge 28）。audit 渠道 tag：
  `v3.17.1-audit.20261030`、`v3.17.2-audit.20261103`。
- **zai-org/ZCode main 已前进**（上轮「3.16.2 后零移动」结论过期）：`3c5b2276..a9fe401e`
  两个 sync commit，作者均为官方 Sync Bot——`a60ba6a7`（2026-10-30）整体刷到 3.17.1
  内部源快照（5231 files，+216k/−611k），`a9fe401e`（2026-11-03）v3.17.2 正式回流
  （203 files，+9.6k/−1.5k）。**不是 ZCodium 内容回流**：全树无 `cheaperinference` /
  `manualInstall` / `isSessionHistoryManagementCommand` / `macos-15` 等标记。官方
  3.17.x 演化要点：conversation-telemetry 引擎、session-facade/lifecycle 重构、官方
  `closeToTraySupported` 能力门禁（与 ZCodium #77 同源且更早）、custom-command
  shell-expansion 删除、browser-local-preview 新模块。本仓不追同源不整体吸收，
  与 #77/#109 的引入决策互证（官方线在同域演化）。
- **upstream-audit issue 交叉核对**：近 10 天新增仅 #102（v3.17.1 sync 审计）、
  #112（v3.17.2 sync 审计），均为官方源同步审计而非代码变更 issue；与逐 commit
  审计结果无冲突，互证通过。

## 逐项评估

### 1. #108 macOS runner 退役迁移（`839c7a0d`）——引入（高优，发版阻断项）

上游 desktop matrix mac/arm64 runner `macos-14` → `macos-15`（macos-14 已于
2026-11-02 退役，actions/runner-images#13518），并加矩阵合同测试。
**本仓核对：`.github/workflows/release.yml:300` 仍是 `runner: macos-14`**（全仓唯一
命中；本仓已主动移除 Intel mac 构建，只需迁 arm64 一行）。退役日期已过，本仓下次
发版即踩 brownout/终止。附带可选：上游 runner↔架构合同测试模式可一并参考。

### 2. 模型发现凭据脱敏（`ac9dbd7e`）——引入

上游 `remoteModelCatalog.ts` 新增 `redactCredentials()` + `publicRequestUrl()`：错误
消息返回前对 apiKey、全部 header 值、URL userinfo/query/fragment 做 `[REDACTED]`，
覆盖原文/JSON 转义/URL 编码三种回显形态按长度降序替换；HTTP 状态提示只保留
origin+pathname。根因：Node fetch 对非法 header 的异常会原样回显 header 值。
**本仓核对：`packages/services/src/model-provider/remoteModelCatalog.ts:51-81` 与上游
修前完全同构**——`request.url` 原样拼进错误 hint（userinfo/query/fragment 泄露）、
catch 分支原样返回 `error.message`（apiKey 经 fetch 异常回显泄露），模型发现链路无
脱敏；spec `docs/specs/model-provider-remote-model-detection.md:49` 仍写「UI 展示原文
消息」需同步改。上游补丁自包含（纯函数 + 4 单测 + ui 回归），可直接比对本仓同文件
移植。本仓其他 redact 实现散在 feedback/exportLogs/autoUpdater（仅 URL query），
无模型发现链路覆盖。

### 3. 历史管理无模型控制面（`3f7bd8bd`，#109，641 行）——backlog（引入候选，需立项）

上游根因：`sendConversationCommandV4` 对 rename/deleteSession 也走 `getClient()`，
命中模型执行启动门禁——空/无效模型配置时历史管理不可用。修复：协议层
`isSessionHistoryManagementCommand`（仅 rename/deleteSession，新命令默认不放行）、
Host 侧改走 `getReadOnlyClient()`、CLI 侧 CommandInbox `prepareDecision`（未订阅会话
同一 admission 内冷恢复）+ deleteSession busy 守卫（`V4SessionBusyError`，不先 stop）。
**本仓同款缺陷面成立**：`packages/services/src/zcode-agent/zcodeAgentService.ts:5113`
无条件 `getClient(params)`（readiness 不 ready 即抛 providerNotReady，本仓已有
`getReadOnlyClient()` 可直接套）；CLI `command-inbox.ts` 无 prepareDecision 钩子；
`session-mgmt.ts:160` deleteSession 无 busy 守卫。本仓会话管理域（tasks-index.sqlite、
归档/置顶）与上游同源共享协议层，不是 ZCodium 特有面。跨 shared/services/CLI 双端
641 行，属会话管理域结构改动——按本仓惯例需 spec 先行立项，上游
`docs/issues/109` 的最小公共合同（缺失会话标准拒绝、重复删除不复活、busy 拒绝不先
stop）可直接作验收清单。

### 4. 托盘创建失败门禁（`811dc560`/`128d367b`，#77/#92）——backlog（单点加固）

上游 `closeToTraySupported` 门禁：平台 ∧ `desktopTrayReady`（Tray 实例创建成功）∧
（初版 Linux monitor，后收紧为 win-only）。**本仓残余风险**：`desktopTray.ts:21-41`
非 win32/Tray 构造失败返回 null 后被 `index.ts:1864` 忽略，Windows 下 Tray 创建失败
时窗口仍会 hide 到不存在的托盘（用户无处找回窗口）；关窗参数契约本身一致（本仓无
上游当初的参数名错配）。低成本单点加固可对齐；官方 3.17.x 亦自带同域能力门禁
（`upstream-readonly/main:packages/desktop/src/main/desktopWindowLifecycle.ts:418-441`），
实现可参考官方线。

### 5. updater feed/通道/未签名 mac（`fb15ad81`/`1113c8e3`/`2471d1f5`，#88）——不适用 + 备忘

- **不适用**：上游根因（打包 `app-update.yml` publish.url 为 `localhost:8081` 占位 +
  运行时漏 setFeedURL）本仓不存在——本仓 autoUpdater 走 `provider:"github",
owner:yachen4ever, repo:yazcode` 且 `allowPrerelease=true`（26.2.0 起发布全
  prerelease，generic `/releases/latest` 会 404）；stable 锁定等价已有
  （`resolveUpdateReleaseChannel` 硬编码 stable）；mac 未签名手动安装引导与本仓
  真实签名/公证路线互斥（本仓有 identity/hardenedRuntime/两段式公证基建）。
- **备忘 1**：上游新增更新契约 CI（`desktop-update-contract.yml`，path 触发跑
  `github-updates.test.mjs`）可作本仓门禁参考。
- **备忘 2（自用清理项）**：本仓 `packages/desktop/tests/github-updates.test.mjs` 是
  孤儿测试（无 workflow/package script 引用），且断言过期（仍断言 generic provider +
  ZCodium feed，与现行 github provider 不符，17c77f0e 引入后未随 888e87a0 更新）——
  建议删除或改写后接线。

### 6. Cheaper Inference 预设（`783463e0`）——不适用（产品立场）

纯声明式数据条目（builtin.json 模板 + logo 溯源 + ProviderLogo 注册），无代码逻辑。
与上轮对 #25 Coding Plan（立场性不引入）、#15 OrcaRouter（可选未采）同类：第三方
inference 网关预设采与不采属产品立场，延续不采。

### 7. model catalog executor 装配归属（`89bb2d73`）——不适用

上游把 `createRemoteModelCatalogExecutor` 内建进 ProviderRuntime 默认装配；本仓在
`packages/services/src/node.ts:1634` 单一创建入口显式注入 `listRemoteModels`，功能
等价，差异仅装配责任归属（Runtime vs createLocalServices），非缺陷。

### 8. 归档会话设置入口（`a0cf1b3a`，#99）——不适用

上游问题形态是「ArchiveManagement 组件在、settings 分区注册丢」；本仓归档管理走
侧栏内联（`WorkspaceSidebar.tsx:1442` 渲染 `WorkspaceArchivedTasksFlatSection` 含
`DeleteAllArchivedTasksButton`），信息架构不同，无同款缺口。

### 9. 侧栏文件树标题栏占位（`8fd6aa6a`，#104）——不适用

本仓文件树 overlay 在常驻 `h-12 [app-region:drag]` 标题栏下方的容器内滑入
（`WorkspaceSidebar.tsx:1313-1320,1746-1780`），天然不与顶部浮层重叠；上游贡献点
（overlay 让出 48px + 返回按钮 testid 命名）仅当本仓日后给文件树加返回按钮时复用。

### 10. B1/B2 合入后的上游侧加固（`b5d441a6`/`94527958`/`c16e66fc` 等）——备忘

PR #94/#96 合并时 maintainer 另补 AST/NodeNext 守卫、负夹具与 committed-push 回归，
属上游侧对贡献的再加固，本仓相应能力本就齐全，无回流项。

## 判定汇总

| #   | 主题                      | 判定                                                        |
| --- | ------------------------- | ----------------------------------------------------------- |
| 1   | #108 macos-14 runner 退役 | **引入（高优）**：release.yml:300 下次发版即踩              |
| 2   | 模型发现凭据脱敏 ac9dbd7e | **引入**：本仓同构泄露面，自包含补丁                        |
| 3   | #109 历史管理无模型控制面 | **backlog（引入候选）**：本仓同款缺陷成立，需 spec 先行立项 |
| 4   | #77 托盘创建失败门禁      | **backlog（单点加固）**：本仓 hide 门禁缺失                 |
| 5   | #88 updater               | **不适用**；备忘：契约 CI 参考 + 孤儿测试清理               |
| 6   | Cheaper Inference 预设    | **不适用**（产品立场延续）                                  |
| 7   | catalog executor 装配归属 | **不适用**（功能等价）                                      |
| 8   | #99 归档设置入口          | **不适用**（架构不同）                                      |
| 9   | #104 文树标题栏           | **不适用**（本仓布局已避开）                                |
| 10  | B1/B2 上游侧加固          | **备忘**（无回流项）                                        |
| —   | zai-org 3.17.x sync       | **登记观察**：官方线演化要点与 #77/#109 互证                |

## 反向贡献状态

- **B3（issue #89 + PR #90）**：MERGED 2026-10-27（`4c3d80a4`，SudoUser）。
  **有 maintainer 补充提交**（`8fc8ef06`）：原实现基线默认 HEAD，pre-push 在提交后
  运行，「破坏性迁移 + 更新后 baseline 同提交」时 `git show HEAD:...baseline.sql`
  拿到新 baseline，校验被绕过；maintainer 改为解析目标分支（显式变量/CI/origin/main
  的 merge-base），无法解析时回退 HEAD 并告警。issue #89 CLOSED，无其他回归要求。
  **本仓核对：`scripts/check-sqlite-schema.ts:19-20` 基线默认 HEAD、:64
  `git show ${base}:${path}`——同款绕过面成立**。
- **B1（PR #94，ci(gate): verify:pre-push 纳入根 typecheck）**：MERGED 2026-11-01
  （SudoUserReal）。maintainer 回应转述：「感谢贡献。已保留原提交，经#110整合发布
  v1.17.4；另补真实committed-push回归及覆盖边界说明。根检查并非完整Desktop
  Main/语义检查，未把#83错误归为类型问题。最终候选739项定向检查通过。」
- **B2（PR #96，browser-safe root barrels + IOrcaRouterService type-only 导出）**：
  MERGED 2026-11-01（SudoUserReal）。maintainer 回应转述：「感谢贡献。原生产修复与
  贡献提交已保留，经#110合入v1.17.4；另补AST/NodeNext守卫和独立负夹具，覆盖原
  正则漏检的裸Node模块、别名及require，并验证频道一致。Web生产构建与相关定向
  回归通过。」
- **新增 B 类候选（是否开 issue/PR 由用户裁决，未动手）**：
  1. **sqlite schema 基线 merge-base 加固回流**：把 maintainer 对 #90 的加固
     （目标分支基线，防「迁移+baseline 同提交」绕过）回流本仓
     `scripts/check-sqlite-schema.ts`——本仓门禁自身受益，同补丁可再反哺上游
     （上游已修，实为自用加固 + 备案）。
  2. **#109 会话历史管理修复反哺评估**：本仓若按 backlog 立项修复后，同域补丁
     具备反向贡献条件（上游已先行，反向意义有限，仅备案）。

## 关联

- 上一轮评估：`docs/upstream-port-tasks-20261026.md`（B1/B2/B3 反向贡献即该轮产出，
  本轮全部确认合并）。
- 门禁纪律不变：上游只读（fetch --no-tags + show/log），严禁 merge/pull。
