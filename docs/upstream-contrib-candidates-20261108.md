# 反向贡献候选评估：yazcode → ZCodium-project/ZCodium（2026-11-08）

调研方式：只读比对（`git fetch --no-tags` 到 `refs/remotes/zcodium-readonly/main` +
`git show`/`git grep`（blob 按需懒取）+ GitHub search/issues API 查重；未
merge/pull/checkout，未动工作区，未向上游开 issue/PR）。上游基线：ZCodium main
`0e88f6ec`（2026-11-02，v1.17.4；与本仓 11-08 调研轮终点一致，本轮仍零移动）。
本仓基线：main `c4a6fb30`（26.5.7 已合并，含 SSH TOFU 批）。

贡献目标仓 = `ZCodium-project/ZCodium`（既往 B1/B2/B3 均在此合并；maintainer 合并
偏好已验证为**工程护栏类**：类型门禁、基线防绕过、架构守卫）。

## 结论总表

| # | 候选 | 上游同构点 | 成本 | 风险 | 建议动作 | 优先级 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | **toast 反馈零 rAF 依赖** | `packages/ui/src/components/ui/toast.tsx:241,245,408,439` | 小（自包含：1 新模块 + 1 组件改造 + 测试） | 低（前台视觉不变） | **直接提 PR** | **高** |
| 2 | **SSH 主机密钥 TOFU 校验** | `packages/server/src/remote/sshAuth.ts:25-52`（buildSSHConnectConfig 无 hostVerifier，grep 零命中） | 中（283 行新模块 + 接线 + 测试） | 中（三手移植链需声明来源） | **先开 issue 讨论** | **高（安全）** |
| 3 | **`.gitattributes` 行尾归一 catch-all** | `.gitattributes:1-7`（仅 3 条点状规则，无 catch-all；其注释自证已被 CRLF 咬过一次） | 极小（约 10 行属性 + 门禁参数） | 低 | **直接提 PR** | 中 |
| 4 | **宿主注入面 deny-by-default** | `scripts/dev-desktop-env.mjs:57`（`env: process.env` 裸透传，无剥离原语） | 中（需按上游环境定制 allowlist） | 中（默认行为变化需论证） | **开 issue 讨论** | 中低 |
| 5 | 重试预算档位 | 上游已有（`apps/zcode-cli/packages/adapters/src/model/retry-budget.ts` 同构实现） | — | — | **砍掉** | 不建议 |
| 6 | 连通性探测 fail-closed 语义 | 上游无探测特性（本仓 26.5.5 产品面） | — | — | **砍掉** | 不建议 |
| 7 | 台账生成幂等门禁 | 上游已有（`.github/workflows/licenses-notices.yml` 自建「重生成 vs 台账」长期闸门，且比本仓多 artifact+人工 review 环节） | — | — | **砍掉** | 不建议 |
| 8 | 多环境对照隔离法 | 方法论，非代码候选 | — | — | 记录（不作为贡献项） | — |

## 逐候选明细

### 候选 1：toast 反馈零 rAF 依赖——直接提 PR（高）

**上游同构点（逐行核实，与本仓 26.5.6 修前状态逐字同构）**：
`packages/ui/src/components/ui/toast.tsx`
- `:241` `const [visible, setVisible] = useState(false);` +
  `:245` `requestAnimationFrame(() => setVisible(true));` ——可见性经 rAF 翻转，
  翻转前元素停在 opacity-0；
- `:408-439` `ensureHost`/`tryAdd`——容器未挂载时 `requestAnimationFrame(tryAdd)`
  循环重试投递。

**缺陷机制**：Electron 渲染进程在窗口被遮挡/后台/最小化时 rAF 被节流乃至暂停
（本仓 26.5.5 AppImage 活体实测约 0.2 帧/秒）；同 `.then` 里走 React Scheduler
（MessageChannel）的 setState 不受影响。后果：全局 toast（约 69 处消费）在被遮挡
窗口上延迟数秒或**永久丢失**——用户不可见的失败反馈。本仓双盲测试连续两轮
「刷新失败 toast 全程未出现、保存反馈卡（React 状态渲染）正常」即此根因，活体
采样钉死（toast host 已建、容器已挂载、消息项滞留 rAF 重试环 14s+ 不进 DOM）。

**移植形态**：本仓 26.5.6 修复自包含——`toastDelivery.ts` 投递控制器（容器未挂载
缓冲、挂载同步排空；预挂载 update/dismiss 语义保持）+ `ToastMessage` 挂载即可见
（进入动画改 CSS keyframes，`motion-safe`；退出仍 transition+计时器）+ 源级零
rAF 断言测试 + spec。上游文件同名同构，补丁近乎原样落位。

**风险**：低。前台正常场景视觉与交互不变（进入动画保留，右上角进入动画由横向
滑入统一为纵向浮现属可说明的微小视觉差）；后台窗口 toast 从「永不出现」变「DOM
即时正确、帧恢复即可见」——语义只增不减。**上游现状**：search issues 无同域讨论
（toast/rAF 检索仅 1 条无关 RTL 帖）。**接受度预判**：高——共享 UI 基建的确定性
bug 修复 + 自包含测试，正中 maintainer 护栏偏好。**动作：直接提 PR**（含源级
零 rAF 断言与投递契约测试）。

### 候选 2：SSH 主机密钥 TOFU 校验——先开 issue（高，安全）

**上游同构点**：`packages/server/src/remote/sshAuth.ts` 的
`buildSSHConnectConfig`（:25-52）返回的 ConnectConfig 无 `hostVerifier`/`hostKeys`
任何一项（grep hostVerifier|hostKeys|knownHosts = 0）——ssh2 默认接受任意主机密
钥，MITM 可冒充目标主机完成密钥交换、骗取密码/私钥口令。上游 `ssh-backend.ts`
同点调用无校验。

**来源与署名（关键）**：修法源出 **axiom-desu/ZCodium `1575a769`**（Apache-2.0，
同上游许可）：`sshKnownHosts.ts`（283 行：TOFU 存储——无记录落库/匹配接受/变更拒
绝且拒绝原因可区分）+ `sshAuth` 接线 + 语义化错误 + 单测。本仓已按 Apache-4(b)
完成移植（26.5.7 批，PR #17）。向上游贡献 = 三手移植链（axiom → yazcode →
ZCodium），PR 中须完整声明来源与修改（Apache-4(b) 行内声明 + 来源链），依赖符号
`buildSshRemoteHostKey`（上游 shared 同名存在）已核实。

**风险**：中——TOFU 首连落库属默认行为变化（对已习惯无校验的用户，主机换钥时将
被拒），需在 issue 里给出 known_hosts 清理引导与拒绝语义说明。**上游现状**：search
issues（hostVerifier/known_hosts/TOFU）= 0 条，无重复劳动。**接受度预判**：高
——安全加固 + 自包含 + spec 化，正中护栏偏好；但默认行为变化宜先 issue 对齐。
**动作：先开 issue 附缺陷机制与补丁草案，获 maintainer 意向后再提 PR**。

### 候选 3：`.gitattributes` 行尾归一 catch-all——直接提 PR（中）

**上游同构点**：`.gitattributes:1-7` 仅 3 条点状规则（`*.mjs`/`*.sh`/
`*.baseline.sql`），无 catch-all；其自带注释自证痛点真实发生：「Windows autocrlf
检出成 CRLF 会被 db:schema:check 误报为 schema 差异并阻断 pre-push」——上游对该
痛点只做了**点状修补**（把被咬的 `.baseline.sql` 加进规则），同型字节比对门禁
（licensing 台账 inventory.json、快照/夹具类文本）仍暴露。

**移植形态**：本仓 26.5.4 增补批 ① 的选型（catch-all `* text=auto eol=lf` + 显式
二进制兜底 + 行尾敏感门禁参数化，spec `docs/specs/crlf-gate-normalization.md`）。
上游迁移量约 10-20 行 `.gitattributes` + 其行尾敏感门禁的参数化核对。

**风险**：低但**面广**——catch-all 会使上游一次性产生全仓行尾归一的「伪 diff」
（需一次性的 renormalize 提交，windows 协作者需重新 checkout）；对上游这是需在
PR 说明里讲清的一次性迁移成本。**上游现状**：无相关 issue/PR。**接受度预判**：
中高——他们已被咬过一次，痛点自证；但 renormalize 全仓 diff 较大，宜 PR 里给出
「单次 renormalize commit + 零内容变化」的核对说明。**动作：直接提 PR**（或与
候选 1 拆开单独提，避免混入行为性改动）。

### 候选 4：宿主注入面 deny-by-default——开 issue 讨论（中低）

**上游同构点**：`scripts/dev-desktop-env.mjs:57` 以 `env: process.env` 裸透传宿主
环境拉起 dev Electron（:69 仅做 node 路径钉扎），全仓无注入剥离原语（grep
stripHost/deny/hostEnvBoundary = 0）。上游与官方 ZCode 共享 `ZCODE_*` 环境变量
命名空间——装有官方 ZCode 的开发者机器上，官方注入变量会污染 ZCodium 的
dev/运行实例（本仓机队实践已实证同类污染形态）。

**移植形态**：本仓 `packages/shared/src/hostEnvBoundary.ts`（deny-by-default +
单元级权限）+ `scripts/host-env-boundary.mjs`（剥离原语 + 显式 allowlist + CI 语境
显式参数化）+ spec。

**风险**：中——allowlist 必须按上游的真实环境面重新圈定（上游 CI/dev 的合法注入
变量集与本仓不同），默认拒绝可能误伤上游既有工作流；属「机制引入 + 上游定制」
而非直接移植。**上游现状**：无同域讨论。**接受度预判**：中低——护栏类正中偏好，
但改动横跨 dev 脚本/运行时边界且需要 maintainer 参与圈定 allowlist，直接 PR 容易
卡在「默认行为变化」上。**动作：开 issue 给出缺陷形态 + 本仓机制说明 + allowlist
圈定提案，由 maintainer 定方向后再决定是否 PR**。

### 砍掉的线索及原因

- **线索 5（重试预算档位）**：上游 `apps/zcode-cli/packages/adapters/src/model/
  retry-budget.ts` 已有同构实现（single/unbounded 档位、同一哨兵常量
  `UNBOUNDED_RETRY_MAX_ATTEMPTS`，且比本仓多一个 `resolveRetryOptionsForBudget`
  归一助手）——本仓该文件本就源自同源代码，无差可贡献。「CI 语境显式参数化」
  半边并入候选 4 的宿主注入面机制，不单列。
- **线索 6（连通性探测 fail-closed 三方语义）**：上游不存在连通性探测特性
  （`probeProviderConnectivity` 为本仓 26.5.5 产品面），无同构点。按筛选原则
  「无同构点不算候选」砍掉。
- **线索 7（台账生成幂等自检口径）**：上游已自行实现同款且更完备——
  `.github/workflows/licenses-notices.yml` 自述「依赖树或台账输入一变就自动重生成
  并与已入库台账比对，不一致直接失败」，另加 artifact 回传 + 人工 review 防 CI 直写
  main。上游现状已覆盖本仓创新点，砍掉。
- **线索 8（多环境对照隔离法）**：方法论，非代码候选；记录于本仓调研文档
  （`docs/upstream-port-tasks-20261108.md`），不作贡献项。

## 建议动作汇总（须用户最终授权后方可执行）

| 顺序 | 动作 | 形态 | 优先级 |
| --- | --- | --- | --- |
| 1 | toast 零 rAF 修复 | 直接提 PR（含测试与 spec 摘要） | 高 |
| 2 | SSH 主机密钥 TOFU | 先开 issue（附机制与补丁草案 + 来源声明），意向后提 PR | 高（安全） |
| 3 | `.gitattributes` catch-all | 直接提 PR（单次 renormalize 说明） | 中 |
| 4 | 宿主注入面边界 | 开 issue 讨论（allowlist 提案） | 中低 |

## 遗留

- 候选 1/2/3 的上游 file:line 均基于 `0e88f6ec`（本轮上游零移动），提 PR 前需对
  上游 tip 复核一次行号；
- 候选 2 的三手移植链（axiom → yazcode → ZCodium）在 PR 中按 Apache-4(b) 做来源
  与修改声明，具体署名格式提 PR 时再定；
- 本单为纯调研：未向上游开任何 issue/PR，本仓除本文档外零改动。

## 关联

- 本仓 26.5.6 toast 修复：`docs/specs/toast-visibility-throttling.md`（PR #11）；
- 本仓 26.5.7 SSH TOFU 移植：`docs/specs/ssh-remote-hardening.md`（PR #17，源头
  axiom `1575a769`）；
- 前次反向贡献：B1/B2/B3（`docs/upstream-port-tasks-20261105.md` §反向贡献状态）；
- 上游动态总览：`docs/upstream-port-tasks-20261108.md`。
