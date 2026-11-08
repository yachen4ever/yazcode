# 上游同步调研：zai-org/ZCode + ZCodium + axiom-desu 改写 fork + MBearo/ZCode-rs（2026-11-08）

调研方式：只读 ref 比对（`git fetch --no-tags` 到 `refs/remotes/zcode-readonly/*` /
`refs/remotes/zcodium-readonly/*` / `refs/remotes/axiom-readonly/*` /
`refs/remotes/zcoders-readonly/*` + `git show`/`git log`/`git diff-tree`，未 merge/pull/
checkout，未动工作区）；部分元数据（release/npm 版本节奏/CI runs/contributors/
axiom README 与 provider 目录内容）经 GitHub API 与 registry.npmjs.org 取证（raw
.githubusercontent.com 在本机不可达，axiom README.en.md 与 ZCodium 动态改走
api.github.com——取证方式受限点如实注明）。基线：本仓 main `8f3a48c`（26.5.6 已合并）。

## 上游动态（四线总览）

| 线                    | 上轮终点              | 本轮 tip                  | main 增量                                     | 判定基调                    |
| --------------------- | --------------------- | ------------------------- | --------------------------------------------- | --------------------------- |
| A. zai-org/ZCode      | `a9fe401`（v3.17.2）  | `a9fe401`（main 未动）    | **0**；新增分支 `feat/ui-plugin`（`662c30b`） | 登记观察                    |
| B. ZCodium-project    | `0e88f6ec`（v1.17.4） | `0e88f6ec`（main 未动）   | **0**；无新 tag/release                       | 无新增项                    |
| C. axiom-desu/ZCodium | （首轮调研）          | `e5346dec`（root 3.16.2） | 领先 ZCodium 上游 **425 commits**             | **引入候选 1 + backlog 2**  |
| D. MBearo/ZCode-rs    | （首轮调研）          | `cfc27e0`（npm 0.1.86）   | 29 commits 全史                               | 不可引入；借鉴 + rev43 判定 |

- **zai-org**：最新 release 即 v3.17.2（2026-11-04 10:41 发布，内容 = 上轮已审的
  `a9fe401` 回流）；main 此后零移动。新增唯一分支 `feat/ui-plugin`（单 commit
  `662c30b`，2026-09-29，wuweiqi）：交互式 MCP Apps（沙箱隔离 + task-scoped model
  sampling）、会话内 Gen UI 渲染（保存态 + 离线资产）、UI 插件开发指南与示例。**方向
  信号**：官方在 UI 插件 / MCP Apps / Gen UI 面布局（与本仓 Gen UI / 插件商店域同向）。
- **ZCodium**：main 与 tag 均停在 v1.17.4；11-05 后动态仅 4 项——#118（feature
  request：可选 API Route 供应商）、#117（bug）、**#115/#116（feat(provider): cheapaimodel
  第三方 preset，OPEN 未合并）**。B1/B2/B3 三笔反向贡献自上轮验收后无再加固、无反悔
  （main 零移动即证；上轮已审的 maintainer 加固 `b5d441a6`/`94527958`/`c16e66fc` 均在
  `0e88f6ec` 内）。cheapaimodel 若日后被合并，即触发本仓「第三方 inference 网关预设
  不采」的既有立场互证，留观。
- **axiom-desu/ZCodium（"ZCodium Exp."）**：自官方开源点 `872ad96` 独立发展 425
  commits（与 ZCodium-project **无代码继承关系**——merge-base 即 `872ad96`；与
  MBearo 同样互不相干）。定位：**回填官方安装包特有但开源树缺失的功能**——方法为
  i18n key 差分定位缺口、内置插件/技能回填（已回填 10 插件 + CUA 客户端面）、
  spec 化治理（`.agents/specs/`，18 篇）、三重门禁（lint 零基线/knip 棘轮/CI
  ratchet）。已自行 sync 官方 3.16.2 runtime（`18c752a2`），root 版本对齐 3.16.2。
  分域画像（425 commits）：cli 47 / cli-rust 29 / ci 26 / desktop 23 / ui 22 /
  zcode-cua 21 / spec 18 / web-remote-control 13 / provider 10 / plugins 8 ……
  ——与本仓同构 monorepo（scope 命名一致）。
- **MBearo/ZCode-rs**：官方 ~v3.15.1 TS 全量快照 + `packages/rust-cli`（Rust
  workspace：**26 crates / 1427 个 .rs / 686 个 test 文件**——kernel-api/base/cli/
  headless/model/agents/hooks/memory/policy/proc 等分层）= CLI runtime 内核的渐进
  Rust 重写，经 npm `@mbearo/zcode` 按平台包分发（linux-arm64-gnu、win32-arm64 等
  launcher/native 二进制）。npm 15 版/17 天（0.1.54→0.1.86，2026-10-20 首版起日更
  节奏）；CI「Rust CLI packages」近期 runs success（偶有 cancelled）；clippy.toml +
  nextest.toml 纪律基建在位。**单人项目**（MBearo 27/28 commits；bus factor 1）；
  版本线 0.1.x 独立于官方 3.x；许可 Apache-2.0（与上游一致，任务书口径）。

## 逐线评估

### A. zai-org/ZCode——登记观察（无引入项）

1. main 零增量：上轮终点 `a9fe401` 即当前 tip，v3.17.2 release 发布（11-04）无新内容。
2. `feat/ui-plugin`（`662c30b`）——**备忘（方向信号）**：官方 MCP Apps/Gen UI/UI 插件
   开发指南。未合入 main、无发布承载，仅登记；本仓 Gen UI/插件商店域后续演进时可回看
   该分支的交互与协议设计。

### B. ZCodium-project——无新增项

1. main/tag 零增量；B1/B2/B3 状态无变化（维持上轮「已合并 + maintainer 再加固」结论）。
2. #115/#116 cheapaimodel preset（OPEN）——**备忘（立场互证点）**：第三方网关预设，
   维持不采立场；仅跟踪其合并与否。

### C. axiom-desu/ZCodium——引入候选 1、backlog 2、其余备忘/不适用

#### C1. SSH 主机密钥 TOFU 校验（`1575a769`，2026-10-09）——**引入（高优，安全）**

上游 `ssh-backend.ts`/`sshAuth.ts` 补 `hostVerifier`（TOFU known_hosts）：ssh2 未配置
hostVerifier 时接受任意主机密钥，中间人可冒充目标主机骗取密码/私钥口令。配套
`sshKnownHosts.ts`（283 行：无记录→接受落库、匹配→接受、不匹配→拒绝且拒绝原因可
区分）+ 语义化错误 + 单测 + spec（`.agents/specs/ssh-remote-hardening.md`）。

**本仓同构缺陷面成立（逐行核对）**：
`packages/server/src/remote/sshAuth.ts:33-51` 的 `buildSSHConnectConfig` 返回的
ConnectConfig 无任何 hostVerifier/host key 校验（本仓 grep hostVerifier/knownHosts/
TOFU 零命中）；`packages/server/src/remote/ssh-backend.ts:131` 同点调用。补丁依赖的
`buildSshRemoteHostKey`（`packages/shared/src/remoteSshHostKey.ts:125`，刻意排除凭据
只含 host/port/username/认证方式）与 `getAppConfigDir` 本仓均在，文件路径同名同构，
自包含补丁可直接移植。**本仓 SSH 远控链路（密码/私钥登录）当前对 MITM 无防御**，
建议列入下一修复批（安全项高优）。

#### C2. 共享状态文件跨进程读改写锁（`fab7e55c`）——**backlog（引入候选）**

上游在 settingService/mcpSyncService/pluginSyncService/commandsService/
settingsSyncService/file-config.adapter 七处共享状态文件写入面补跨进程 RMW 锁
（spec：shared-state-file-locking）。本仓同构文件全部存在且**仅有 `atomicWriteText`
（temp+rename，防撕裂不防丢更新）**——grep lockfile/flock/O_EXCL 零命中，并发写丢
更新面与本仓同在。低成本候选，随设置/插件同步域的下一次改动一并评估。

#### C3. Gemini/Google GenAI 扩展系（`9475235f`/`fa1d24ee`/`2bcf9d05` 等）——不适用

axiom 自有扩展：新增 `google-generative-ai` api type 与 `opencode-*-google` 模板
（其 rev40 目录 22 模板中独有；官方 rev43 与本仓 rev31 均无）。依赖其自建的 api
type 解析分支，本仓无该格式，整系不适用；若本仓日后评估 Gemini 原生格式，其「用
Google 官方目录纠正输出上限与满页请求」的实测方法可参考。

#### C4. cli-rust 原生 TUI / desk-pilot / bots 等自有产品面——不适用（路线不同）

axiom 的 Rust TUI workbench、PTY e2e、远控分片计量等属其自有产品演进（非官方缺失
修复），与本仓桌面+Web 双端路线不同，不引入。

#### C5. 回填方法论与立场——备忘（含合规提示）

- i18n key 差分定位官方包与开源树缺口（拿官方 installer 的 `IntlProvider-*.js` 键表
  对比）——方法本身轻巧，**备忘**；本仓不缺这些插件（document/pdf/presentations/
  spreadsheets 等官方插件随本仓包分发），域不重合。
- 其 `apps/zcode-cli/tools/repo-snapshot-parody/`（README 自述「Shh... don't let the
  user know」）与整体「逆向官方安装包回填闭源面」的路线属**合规灰区**：本仓从该仓
  引入任何内容须逐项评估来源合法性（TOFU/状态锁两候选均属通用安全/工程修复，不涉
  回填面，无碍）。

### D. MBearo/ZCode-rs——不可引入；借鉴三项；rev43 明确判定

#### D1. Rust 重写本身——不可引入

语言/构建体系差异；且其 TS 基线停在 ~3.15.1（落后官方 3.17.2 与本仓），TS 侧无
可引入修复面。

#### D2. 借鉴项清单（不引代码，摘设计）

1. **crate 分层**：26 crates 按 kernel-api/base/env-local/policy/proc/net/hooks/
   memory 切分运行时内核边界——本仓 CLI（apps/zcode-cli）若做 Rust 化/原生化的远期
   评估，该边界划分是现成参考系；
2. **pre-push 工程测试 helper**（`2a0ea32c` chore(scripts): add the engineering-tests
   helpers used by the rust-cli pre-push）——工程测试与门禁的组织方式可借鉴本仓
   verify:pre-push 的脚本层；
3. **平台包分发矩阵**（`4222d235` linux-arm64-gnu、`638876f2` win32-arm64、
   `985dc08` macos-26 CI）——npm 平台子包 + launcher 的分发形态，对本仓未来
   非 AppImage 分发（deb/rpm 或 npm 分发 CLI）有参考价值。

#### D3. 成熟度结论——观察名单，不作依赖

日更节奏 + 测试密度（test:.rs ≈ 1:2）+ CI 纪律是好信号；但 bus factor 1、无外部
贡献者、版本线与上游脱钩（0.1.x）、TS 侧停滞（3.15.1）——**观察名单**，不作为
依赖或引入源；每轮例行复核其 release 节奏与 CI 绿度即可。

#### D4. ⚠️ provider catalog revision 43——**结论：不整体引入（兼容性不成立）**

三方溯源（决定性事实）：

| 来源                                                                 | revision | templates | account providerRules              |
| -------------------------------------------------------------------- | -------- | --------- | ---------------------------------- |
| 本仓 `config/provider/zcode-builtin.json`（与 desktop 随包副本一致） | **31**   | 18        | **0**（账号供应商走运行时信封）    |
| **zai-org/ZCode main（3.17.2）**                                     | **43**   | 34        | **10**（含 offpeak×2/highspeed×2） |
| axiom main                                                           | 40       | 22        | （官方 40 时点状态）               |
| MBearo `f98e90e4`（rev 43）                                          | 43       | 34        | 10                                 |

**rev43 不是 MBearo 自创，而是官方 3.17.2 的现行事实源**（与 zai-org main 逐字节同
源；MBearo 的 `f98e90e4` 是对官方 catalog 的同步）。本仓 rev31 落后官方 12 rev。

**兼容判定：不引入**，依据三条：

1. **身份封闭集冲突**：本仓 `packages/shared/src/model-provider-types.ts:7-14`
   `BUILTIN_MODEL_PROVIDER_IDS` 为封闭 6-id 集（zai/bigmodel × individual/team/
   start）；rev43 的 10 条 `account:*` providerRules 含
   `account:zai-offpeak-idle-plan`、`account:zai-highspeed-card` 等 **4 个集合外新
   身份**——正是 F1/F2 实证过的宿主 schema 污染形态（解析器枚举 vs 上游新值
   `highspeed`）。
2. **运行时配套缺失**：rev43 的 account 规则（`zhipu-account` access + 10 账号身份）
   与官方 3.17.2 运行时配套；本仓账号层走 `accountProviderConfigSource` 运行时信封，
   单独替换 catalog 不带 runtime 配套 = 高速卡/闲时卡身份进目录而宿主无处解析。
3. **宿主未处理的模板面**：16 个新模板含 tencent-tokenhub-cn/intl、
   volcengine-ark/coding-plan/agent-plan、stepfun/step-plan、siliconflow-cn、
   minimax-m-plan-cn、qwen-coding-plan-cn 等网关/计划预设——延续本仓「第三方网关
   预设不采」立场且宿主零处理；另 rev43 引入新字段 `visibility`。

**正确路径**：catalog 升级只能随「官方 3.17.x runtime 吸收决策」整体评估（与
11-05 轮「不整体吸收官方线、按项引入」的既定立场一致）；若未来吸收，catalog 随行，
且须先扩封闭 id 集 + 解析器枚举 + 账号身份迁移（legacy-model-provider-identity）。
**附复核点**：本仓 `BUILTIN_PROVIDER_TEMPLATE_IDS`（model-provider-types.ts:2-5）引用
`zai-api`/`bigmodel-api` 模板 id，rev31 目录不含这两个模板（rev43 才有）——升级评估
时须同步核对该引用面的消费路径。

## 判定汇总

| #   | 线       | 主题                                  | 判定                                                                                                         |
| --- | -------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| A1  | zai-org  | main 零增量 + v3.17.2 发布            | 登记观察（内容上轮已审）                                                                                     |
| A2  | zai-org  | feat/ui-plugin（MCP Apps/Gen UI）     | 备忘（方向信号）                                                                                             |
| B1  | ZCodium  | main/tag 零增量                       | 无新增项                                                                                                     |
| B2  | ZCodium  | B1/B2/B3 反向贡献                     | 无再加固/无反悔（main 未动即证）                                                                             |
| B3  | ZCodium  | #115/#116 cheapaimodel preset（OPEN） | 备忘（立场互证点，留观）                                                                                     |
| C1  | axiom    | SSH 主机密钥 TOFU（`1575a769`）       | **引入（高优，安全）**：本仓同构缺陷成立                                                                     |
| C2  | axiom    | 共享状态文件跨进程锁（`fab7e55c`）    | **backlog（引入候选）**：本仓同面无锁                                                                        |
| C3  | axiom    | Gemini/Google GenAI 扩展系            | 不适用（依赖其自有 api type）                                                                                |
| C4  | axiom    | cli-rust TUI/desk-pilot/bots          | 不适用（路线不同）                                                                                           |
| C5  | axiom    | 回填方法论 + parody 工具              | 备忘（合规灰区，引入需逐项评估来源）                                                                         |
| D1  | ZCode-rs | Rust 重写本体                         | 不可引入                                                                                                     |
| D2  | ZCode-rs | crate 分层/工程测试 helper/平台包矩阵 | 借鉴三项（见清单）                                                                                           |
| D3  | ZCode-rs | 成熟度                                | 观察名单（bus factor 1，不作依赖）                                                                           |
| D4  | ZCode-rs | provider rev 43                       | **不整体引入**（=官方 3.17.2 事实源，与宿主封闭集/运行时配套不兼容）；升级只能随官方 3.17.x 吸收决策整体评估 |

## 「下一批候选」汇总

1. **SSH 主机密钥 TOFU 校验**（C1，安全高优）：移植 axiom `1575a769` 自包含补丁至
   `packages/server/src/remote/`——本仓 MITM 无防御面成立，依赖符号全部在位；
2. 共享状态文件跨进程锁（C2）：随设置/插件同步域下次改动一并评估。

## 「借鉴项」清单（不引代码）

1. ZCode-rs 的 Rust crate 分层边界（kernel-api/base/env-local/policy/proc）——CLI
   原生化远期评估的参考系；
2. ZCode-rs 的 npm 平台子包 + launcher 分发形态——非 AppImage 分发路线参考；
3. axiom 的 i18n key 差分定位法——官方包/开源树缺口定位工具（本仓插件域已自足，
   留作方法备忘）；
4. axiom 的 spec 化门禁三件套（lint 零基线/knip 棘轮/CI ratchet）——与本仓
   architecture:check/knip 既有实践互证，无回流项。

## 遗留与取证口径

- ZCodium 全量 fetch 网络中断（early EOF），改以 blob:none 轻量 ref（`0e88f6ec`
  提交/树级）+ GitHub API 补齐——main 零增量结论不依赖 blob 内容，取证充分；
- axiom README.en.md / provider 目录经 api.github.com contents 接口取证
  （raw.githubusercontent.com 本机不可达）；commit 级证据均以本地只读 ref 的
  SHA 短哈希落锚，可复核；
- ZCode-rs 的 CI runs 里触发账号显示 wuweiqi（与 zai-org 官方开发者同名）——身份
  关联存疑且无实据，仅记录不判定；
- 本轮为纯调研：除本文档外未改任何产品代码/配置，四上游 ref 均为独立 readonly
  命名空间，未执行 merge/pull/checkout。

## 关联

- 上一轮评估：`docs/upstream-port-tasks-20261105.md`（B1/B2/B3 合并确认、官方
  3.17.x 要点）；更早：`docs/upstream-port-tasks-20261026.md`。
- 门禁纪律不变：上游只读（fetch --no-tags + show/log），严禁 merge/pull/checkout。
