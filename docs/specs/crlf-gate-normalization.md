# Spec：门禁 autocrlf 行尾伪影归一化（26.5.4 增补批 ①）

## 背景（痛点实证，三次实踩）

git `core.autocrlf=true` 的 Windows checkout 会把全部文本文件落成 CRLF，行尾敏感的
本地门禁据此产生「文件漂移」误报：

1. r9000x 26.5.2 回执暴露（Windows checkout 伪影）；
2. m5air 26.5.3 验收节提交时 `pnpm fmt:check` 误报 153 文件漂移（main 实际干净）；
3. licensing 台账同族敏感（台账/清单与重生成产物按内容比对，CRLF checkout 下
   磁盘内容与生成器输出的 LF 不一致即漂移）。

根因：门禁对 git autocrlf checkout 产生的行尾伪影不做归一化——**敏感点全部位于
「checkout 产物」层**（oxfmt 与台账生成器都读工作区磁盘文件），而不是门禁自身逻辑。

## 选型论证（路线 A / B）

| 路线                | 内容                                                                                             | 评估                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A（采纳，治本）** | `.gitattributes` 追加 `* text=auto eol=lf`（显式 binary 规则兜底），`git add --renormalize` 收编 | 归一发生在 checkout 层：任何平台/任何 autocrlf 配置下工作区文本恒 LF，所有行尾敏感门禁一次性免疫；`text=auto` 对真二进制（NUL 探测）自动豁免                                          |
| B（不单独实现）     | fmt:check / licensing 门禁在比对前各自做行尾归一化                                               | 每个门禁各塞一层归一化 = 同一语义多处复制（违反不复制规则）；oxfmt 为第三方工具无法内嵌，需包一层包装脚本，复杂度不成比例；A 落地后 B 的保护对象（checkout 产物）已归一，B 无增量价值 |

**存量影响面评估（选 A 的前提实证，2026-11-07）**：`git grep -Il $'\r' HEAD` 全仓
恰 4 个含 CR 文件——`THIRD-PARTY-NOTICES.md`、`third-party/upstream/**`、
`third-party/native-search/licenses/**`——**全部已被既有 `-text` 规则覆盖**（字节
原样保存，上游许可原文不得转行尾）。因此 catch-all 落地后 `git add --renormalize`
的入暂存 diff 为**空**，不存在「存量 CRLF 大重写」。`third-party/**` 是禁区：仅
`.gitattributes` 属性行变化，不触碰文件内容。

## 行为规则

1. **catch-all 归一**：`* text=auto eol=lf`（入库归一 LF、检出恒 LF，Windows 的
   autocrlf 配置不再改变工作区行尾）。既有 `-text` 字节保护规则（THIRD-PARTY-NOTICES.md
   与 third-party 原文）置于 catch-all 之后，按 git attributes「后者覆盖」语义继续
   生效——这些文件在任何平台字节原样检出。
2. **显式 binary 兜底**：仓库在册二进制扩展名（png/icns/ico/zip/gz/woff2 等）显式
   `binary`，防 text=auto 的 NUL 启发式误判把二进制当文本归一。
3. **门禁不变**：fmt:check / licensing 门禁自身逻辑零改动——免疫来自 checkout 归一，
   不是门禁内归一。CI（Linux，无 autocrlf）行为不变。
4. **`.gitattributes` 自身生效边界**：attributes 随树走，修复 commit 起的所有检出
   （含既有 clone 的 Windows 机器）在 checkout/恢复文件时自动得到 LF；已处于 CRLF
   伪影状态的旧工作区需一次性 `git checkout -- <files>` 或重新 checkout 恢复（属
   使用者一次性动作，不进工具链）。

## 验收场景

1. **renormalize 零 diff**：catch-all 落地后 `git add --renormalize .` 入暂存为空
   （存量影响面 = 0）。
2. **Windows autocrlf checkout 模拟**：`git -c core.autocrlf=true worktree add`——
   - 修复前基线（65f4bfca）：工作区 .ts 等文本文件出现 CRLF（复现伪影）；
   - 修复后：同一模拟下文本文件恒 LF，`oxfmt --check` 不因行尾漂移报错。
3. **字节保护区不回归**：THIRD-PARTY-NOTICES.md 与 third-party 原文在模拟 checkout
   下字节与入库一致（`-text` 不被 catch-all 翻转）。
4. **macOS/Linux 常规路径不回归**：本机 `pnpm fmt:check`、`pnpm verify:pre-push`
   全绿。
