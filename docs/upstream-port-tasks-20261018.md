# 上游（ZCodium-project）变更引入评估与任务书

> 产出背景：ZCodium 侧会话 2026-10-18 应用户要求做的反向移植分析。
> 基准：上游 main@9cd5e0e4（含 #40/#57/#58/#60），对比 yazcode main@584e4b3（26.1.3-dev）。
> 逐项核对了 10-06 首轮反向移植调研之后的全部上游提交。

## 结论（TL;DR）

**零碎层面没有需要立刻引入的东西**——逐项核对后，上游近期变更要么 yazcode 已有同源等价实现，要么与 yazcode 产品立场相悖。唯一有实质价值的是 **#43 再基线带进来的 UI Plugin（MCP Apps）/ gen-ui 系统**，属既有 backlog 大件（此前已拍板「等宿主接线一起做」），本文以 T1 立项供拍板，另有 T2 一个小件可选。

## 已核实「无需引入」清单（存档理由，后续会话不必重查）

| 上游项 | 判定 | 依据 |
| --- | --- | --- |
| #29 插件：Codex 根 hooks.json 兼容 + zip 内存解压防挂起 | **已吸收** | `hook-sources.ts` 已有 CODEX_HOOKS_PATH 回退逻辑；`zip-source.ts` 已是 `archiveBytes` + `yauzl.fromBuffer`（yazcode 侧早已移植） |
| #47 禁用强更启动门禁 | **已有等价** | yazcode 的 `maybeBlockStartupForForceUpdate` 早就是无条件 `return { blocked: false }`（审计版不连官方配置服务） |
| #40 动作行常驻 / 用户消息时间戳 / 共享轮询 / 速度展示 | **已同源** | 常驻：yazcode 基线从无 hover 门控（动作行恒显）；时间戳：UserInputRow 已有 timeLabel（864/1297）；共享轮询与速度双缺陷修复：v1.0.7 首创 + 2026-10-17 22a15d1 已修 |
| #56 services 测试脚本对齐 vitest | **不适用** | yazcode 测试为 node:test 形态且无该脚本问题；全测试域 `process.cwd()` 零命中（已扫描 packages/*/test 与 apps/zcode-cli/tests） |
| #58 rewardsMenuIcon / #49 footer 登录入口 | **不适用** | yazcode 无账号/奖励体系（去智谱彻底） |
| #45 release 修复群 | **不适用为主** | gen-ui alias 依赖 gen-ui 大件；数据根/决策窗口 yazcode 自有方案；WRC yazcode 无 mobile 目录；i18n 微修无独立价值 |
| #41 版本体系 / #37 侧栏版本号 / #35 CLI 类型门禁 / #31 provider 打包 / #33 licenses AND 分类 | **已有等价** | yazcode 各自独立落地过（92b3be1、ffd11c4、645114e+1c33104、645114e、v1.0.4 许可三连修） |
| #19 数据根归属文件迁移 / #25 Coding Plan 预设恢复 | **立场性不引入** | #19 两侧方案已定型分歧；#25 与去智谱立场相悖 |
| #27 linked-issue 门禁 / #60 oxfmt 归一 | **不适用** | 仓库 CI/格式化惯例属上游仓自己的事 |
| #15 OrcaRouter | **可选未采** | 沿用 10-06 判断：parity 可选，yazcode 无需求场景 |
| #43 再基线的其余技能（opentui 编程向、e2e-case-lifecycle、zcode-large-task-fixture 等） | **不建议** | 与办公向定位不符或已自有等价；react-best-practices/ai-elements 刷新维持 10-11 判断「可跟进但低优先级」 |

## T1（需拍板的大件）：UI Plugin（MCP Apps）/ gen-ui 宿主接线

### 这是什么

zai-org v3.15.1 引入、随上游 #43 再基线进入 ZCodium 的会话内交互页面系统：工具结果可以携带**交互页面**（画板/表单/图表，MCP Apps 形态），另有会话侧栏面板、页面与主对话协作、App 内模型调用（`createSamplingMessage`）。官方绑定 `@modelcontextprotocol/ext-apps` SDK（页面锁 2.0.0 / MCP 1.29.0）。对 yazcode 办公场景的直接价值：**agent 产出可交互的 Excel/文档预览与表单**，而不是静态文本或外开文件。

### 上游参考索引（只读参考，严禁在 yazcode 目录 merge/pull 上游）

- 规格：`docs/specs/gen-ui-external-links.md`、`gen-ui-file-summary.md`、`gen-ui-inline-sizing.md`、`gen-ui-output-directory.md`、`visualize-cli-loading.md`（上游 main@9cd5e0e4）
- 实现：`packages/shared/src/gen-ui/**`、`packages/ui/src/gen-ui/**`、bootstrap/CLI 侧 gen-ui 产出管线（`git grep -l "gen-ui" zcodium/main -- packages apps` 自行展开）
- 官方 visualize 插件（v0.1.0，Apache-2.0）：HTML fragment + render.py 沙箱 iframe + d3/lucide vendored
- 参考方式：`git fetch zcodium`（fetch 只加 ref，安全）后 `git show zcodium/main:<path>`；**绝不在 yazcode 目录对上游执行 merge/pull**（2026-10-16 双仓误 pull 事故前科）

### 分期建议（先评估出 spec，再实施）

1. **评估阶段（0.5-1 天）**：通读上游 5 份 gen-ui spec 与 ext-apps SDK 合同，产出 yazcode 侧 spec（`docs/specs/`，契约先行）——核心决策点：宿主渲染面用什么（IAB 新分区 vs 会话侧栏面板）、可视化目录约定（上游用 workspace 下 gen-ui 输出目录，yazcode 对齐即可）、与 `persist:zcode-embedded-browser` 分区及 `desktopIabDownloadAutoSave` 下载落盘的关系。
2. **P1 最小闭环（2-3 天级）**：不接 MCP Apps，先做「fragment → 可视化目录 → IAB/侧栏渲染」的只读可视化链（即此前评估的轻量替代，价值打折但独立可用），含 gen-ui 产出目录与清理约定。
3. **P2 完整 MCP Apps（1-2 周级）**：ext-apps SDK 接线、工具结果挂交互页面、侧栏面板、`createSamplingMessage` 内模型调用。P1 未验收不启动 P2。

### 验收红线

- spec 先行（AGENTS.md 铁律）；dev 实测走 CDP 9229；不引内网信息；不动版本语义（y 位=引入上游变更批次，这项若立项即是一次 y 位批次的主体）。

## T2（可选小件）：强更门禁 stub 的回归测试

上游 #47 为「禁用强更门禁」补了 `forceUpdateNoop.test.ts`（74 行）。yazcode 的 `maybeBlockStartupForForceUpdate` 同样是无条件 `{blocked: false}`（审计版安全姿态的承重墙），但**没有测试锚**——将来重构误删 stub、或引入真实外联都不会被拦。移植该测试并按 yazcode 惯例改 node:test 口径，断言两点：恒 `blocked: false`；调用期间无任何网络请求（mock fetch/net 断言零外联）。约 0.5 天。

## 明确不做

除上表「不引入」各项外，重申两条既有决策不变：独立产品线**不追与上游同源**（不做整体再基线吸收）；MBearo/ZCode-rs 维持挂观察。
