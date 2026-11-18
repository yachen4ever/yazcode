# 上游例行调研：zai-org/ZCode v3.18.2 + ZCodium v1.18.0 + MBearo/ZCode-rs 0.1.88（2026-11-18）

调研方式：只读 ref 比对（`git fetch --no-tags --filter=blob:none` 到
`refs/remotes/{zcode,zcodium,axiom,zcoders}-readonly/*` + `git log/show/diff-tree`）
+ GitHub API 取证（compare / contents / issues，经 192.168.5.5:1080 代理）。未
merge/pull/checkout，未动本仓工作区（本文档除外）。本仓基线：main `70198df2`，
**26.5.10 批已含**：visual-judge `model: inherit`（#34）、`{{sessionId}}` headers
占位符 + 保护头（#36）、OV 连接配置对账（#38）——评估以之为新基线，防建议重复引入。

## 四线总表

| 线 | 上轮基线（11-08） | 本轮 tip | 变化 | 基调 |
| --- | --- | --- | --- | --- |
| A. zai-org/ZCode | `a9fe401e`（v3.17.2） | `fec97590`（11-13，v3.18.2） | **3 个 sync commits，5140 文件 +434,847/-45,066** | 登记观察 + catalog 差距扩大 |
| B. ZCodium | `91b9486c` | `cf24e347`（11-10，v1.18.0） | 3 commits | 登记；我方六条上游帖零回应 |
| C. axiom-desu | `e5346dec` | 同 tip | 无新提交 | 一句话记录 |
| D. MBearo/ZCode-rs | 0.1.86（`cfc27e0e`） | `a7a980de`（11-13，0.1.88） | +2 commits（catalog rev44 同步 + release） | 仍观察名单 |

## A. zai-org/ZCode：v3.17.2 → v3.18.2

- 3 个 sync commits（`b95ebaff` v3.18.0 → `c5904686` v3.18.1 → `fec97590` v3.18.2）；
  compare v3.17.2...v3.18.2：**300 files，+43k/-4k 级（THIRD-PARTY-NOTICES 28k 行占
  大头），apps/zcode-cli 14,634 行、packages/desktop 2,381 文件、packages/ui 612、
  packages/services 196、packages/shared 131**。全量 diff（两 blobless ref 间）
  5140 files +434,847/-45,066。
- **apps/zcode-cli 变更主题（抽样）**：provider-builtin-tool-compat 扩展
  （analyze-image MCP 格式 `compat.ts +144-18`、新 `mcp-format.test.ts` +250）、
  fixtures SSE 新增——官方在 builtin 工具兼容面持续投入。
- **provider catalog：rev43 → rev44**（v3.17.2 实测 43、v3.18.2 实测 44；API contents
  逐 ref 核对）。**与本仓差距 12 → 13**（本仓 `config/provider/zcode-builtin.json`
  仍为 rev31）。schema 兼容结论**沿用 11-08 判定不变**：rev43 已含 4 个本仓封闭
  6-id 账号集外的身份（offpeak×2/highspeed×2）+ `visibility` 字段 + 16 个宿主零
  处理的网关模板；rev44 在其上演进，**不兼容结论不变**——catalog 升级只能随
  「官方 3.18.x 吸收决策」整体评估，本仓 rev31 维持现状。
- **可引入候选（例行口径，未逐项审计）**：v3.18.x 变更集中与官方 builtin 工具
  兼容面相关的改动（compat/mcp-format）属官方插件域，本仓随包分发同源插件，
  **下批可抽 3-5 个 commit 做 26.5.10 级同构核对**（本轮例行调研不做逐项）。

## B. ZCodium v1.18.0（`91b9486c` → `cf24e347`，3 commits）

- `ee694362` fix: 恢复侧栏版本号并**移除智谱套餐预设入口**（`WorkspaceSidebarFooter`
  +5、`model-provider-section/constants.ts` -53）——移除智谱套餐预设模板入口，与本仓
  「官方账号/套餐预设不采」立场同向，备忘即可；
- `13c2002f` fix(ci): **CLI 发行构建固定 production provider 配置**（release.yml）——
  发行构建的 provider 配置装载固定，防发行环境差异；
- `cf24e347` release: prepare v1.18.0。
- **可引入性**：三者均属 ZCodium 自身发行工程/产品面，无本仓同构缺口，不引入。

### 我方六条上游帖状态（如实记录）

| # | 类型 | 状态 | 回应 |
| --- | --- | --- | --- |
| #119 toast rAF 缺陷报告 | issue | **open** | **0 评论** |
| #120 toast 零 rAF 修复 | PR | **open** | 0 评论，未合并 |
| #121 gitattributes catch-all | issue | **open** | 0 评论 |
| #122 gitattributes 修复 | PR | **open** | 0 评论，未合并 |
| #123 SSH TOFU | issue | **open** | 0 评论（本轮追加行号复核评论，见下） |
| #124 宿主注入面 | issue | **open** | 0 评论 |

四天零回应、零合并——maintainer 处理节奏放缓（上轮 B1/B2/B3 为 1-3 天级回应）。
**处置：保持 open 等回应，不催促**；若两周后仍无回应，由用户决定是否改形重投或撤回。

### #123 行号更新（遗留动作，本单已执行）

按新 tip `cf24e347` 复核：`packages/server/src/remote/sshAuth.ts` 现 **169 行**，
`buildSSHConnectConfig` 位于 **:28**（上轮报告为 :25-52 段）；`hostVerifier`/
`hostKeys`/`known_hosts` **零命中**——缺陷仍在、未被上游修复，**结论不变**。
已在 [ZCodium#123 追加评论](https://github.com/ZCodium-project/ZCodium/issues/123#issuecomment-6987044136)
（引用实际 tip 哈希）。

## C. axiom-desu/ZCodium

无新提交（tip 仍 `e5346dec`，10-31）——一句话记录，无调研项。

## D. MBearo/ZCode-rs 0.1.88

- +2 commits：`081e520c` **provider catalog 更新至 revision 44** + `a7a980de`
  release 0.1.88（npm）；
- **rev44 溯源**：官方 3.18.2 catalog 即 rev44（API contents 核对）——MBearo 延续
  「官方 catalog 同步器」定位，跟随及时（官方 11-13 发版，MBearo 同日）；
- **六维复核（对照 11-08 结论）**：发版节奏放缓但持续（本周 1 版 vs 上轮日更）✓；
  CI 与 clippy/nextest 纪律未见退化 ✓；**单人项目不变（bus factor 1）** ✗；TS 基线
  停滞（仍 ~3.15.1）✗；版本线 0.1.x 与上游脱钩 ✗；许可 Apache-2.0 不变 ✓。
- **建议：仍观察名单**（结论与 11-08 一致）。catalog 同步器价值仅在「官方 rev 升级
  的旁证」——本仓已通过官方 API 直接核对 rev44，MBearo 的旁证价值下降。

## 可引入清单与优先级建议

| # | 主题 | 建议 | 优先级 |
| --- | --- | --- | --- |
| 1 | A 线 v3.18.x 官方 builtin 工具兼容面抽审（compat/mcp-format 3-5 commits 同构核对） | 下批例行抽审（随 26.5.11 或 #41 续轮） | 低-中 |
| 2 | catalog rev44 差距（本仓 rev31） | **维持不引入**；随官方 3.18.x 吸收决策整体评估（rev43 结论外推 rev44） | — |
| 3 | 我方六条上游帖 | 保持 open 等回应；两周无回应由用户裁决改形/撤回 | — |
| 4 | #123 SSH TOFU | 等 maintainer 表态（行号已更新） | — |

## 只读红线执行情况

- 四仓 fetch 全部 `--no-tags --filter=blob:none` 到独立 `*-readonly` refs；本仓
  工作区仅新增本文档；未 merge/pull/checkout 上游；GitHub API 取证经代理
  （compare/contents/issues/issues#123 评论——**#123 追加评论为本单任务书明确
  授权的遗留动作**，其余六条未动）。

## 关联

- 上轮评估：`docs/upstream-port-tasks-20261108.md`（rev43 判定、四线基线、axiom 画像）；
- 本仓 26.5.10 批：#34（visual-judge inherit）/ #36（headers 占位符）/#38（OV 对账）
  ——均已完成，评估基线以 26.5.10 为准。
