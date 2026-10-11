# Spec：引入上游官方办公插件（26.1.0）

## 背景

上游 3.15.1（zai-org/ZCode，tag commit `aac4755`）把原 Z.AI 专有许可的办公插件以
**Apache-2.0** 重新发布（许可三重一致：plugin.json、skill 内 LICENSE.txt、仓库根
LICENSE；SKILL.md frontmatter 的 `license: Proprietary` 是未刷净的残留，引入时修正）。
本仓现有办公四件套来自 MiniMax 衍生（MIT，已去残留），处理纪律强、制作工作流弱，
两边**不同源且互补**。用户拍板：引入上游插件形态（plugin+skills），MiniMax 版改名退居。

## 引入范围

| 上游插件 | 引入 | 理由 |
| --- | --- | --- |
| `pdf-plugin`（pdf 0.1.8） | ✅ | 制作工作流（briefs 四路由 / design_engine / visual-judge agent / LaTeX resume / Playwright 渲染）为本仓空白 |
| `documents-plugin`（docx 0.1.8） | ✅ | docx-js 从零创建 + 设计系统 + 批注路由，与 MiniMax C# 修订/redlining 互补 |
| `spreadsheets-plugin`（xlsx 0.1.8） | ✅ | 图表引擎 / VBA 模板 / 分析场景配方 / 质检管线，与 MiniMax pandas 处理链互补 |
| `presentations-plugin`（pptx 0.1.8） | ❌ | 仅 2 文件纯指引（57K，无脚本），MiniMax python-pptx 版（14 文件）更强 |
| `image-search-plugin`（0.1.1） | ❌ | 纯 MCP 声明，依赖 `${ZCODE_BASE_URL}` 官方 JWT 账号鉴权，违背 `no-official-platform` spec |

## 行为规则

1. **引入形态**：上游 verbatim 拷入 `apps/zcode-cli/packages/{pdf-plugin,documents-plugin,spreadsheets-plugin}/`
   （`.zcode-plugin/plugin.json` + `skills/` + `agents/`），登记 copied-components
   （referenceRevision = `aac47556`，即 v3.15.1 tag；Apache-2.0）。
2. **注册**：`apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts`
   按上游四件套工厂模式注册三个插件（`defaultEnabled: true`，Z.ai author，
   productivity 分类）；`scripts/prepare-prebuilds.mjs` 补打包段
   （packageName / relativePath / stagedPath / requiredSeedPaths）。
3. **frontmatter 修正**：三个插件 skills/*/SKILL.md 的 `license:` 行
   `Proprietary. LICENSE.txt has complete terms` → `Apache-2.0. See LICENSE.txt`。
4. **MiniMax 版改名退居**（`.agents/skills/`）：
   - `pdf` → `pdf-ops`：收窄为「对已有 PDF 的操作」——填表 / 合并 / 拆分 / 提取 /
     OCR / 检查 / 修复；排除项显式写「从零创建、格式转换、排版设计 → 用 pdf 插件」。
   - `docx` → `docx-redline`：收窄为「对已有 docx 的修订 / redlining / 格式保持 / 转换」；
     排除「从零创建与设计 → 用 docx 插件」。
   - `xlsx` → `xlsx-ops`：收窄为「对已有 xlsx 的数据处理 / 清洗 / 校验」；
     排除「图表制作 / VBA / 场景建模 → 用 xlsx 插件」。
   - `pptx` 原名不动。
   - SKILL.md name 字段与目录同步改；引用点（AGENTS.md、workwin 技能清单说明）同步。
5. **路由去歧义（防模型困惑）**：
   - MiniMax 三技能的 description 重写为上表窄边界（我方资产，自由改）；
   - Z.ai 三技能 SKILL.md 正文头部各加一行交叉引用
     「对已有文件的操作（填表/合并/提取/修订）→ 见 pdf-ops / docx-redline / xlsx-ops 技能」，
     修改处按仓库惯例带 `Modified by ZCode:` 声明；
   - 模型分流直觉：**造新的走插件，改旧的走 ops**。
6. **许可与门禁**：copied-components provenance 记「上游 SKILL.md frontmatter
   license 残留已修正 + 交叉引用一行已加，其余 verbatim」；`check-skill-residue`
   复核通过（Z.ai 插件不含 minimax/mavis/:5321 残留）；THIRD-PARTY-NOTICES 走
   CI 两阶段回填。

## 状态所有者

- 插件清单唯一权威：`official-plugin-definitions.ts`。
- 打包清单：`scripts/prepare-prebuilds.mjs`（与 bootstrap 注释互相指认，防第三份平行清单漂移）。
- MiniMax 技能归属：`.agents/skills/`（仓库内、随仓库分发）。

## 不在本 spec 范围

- visualize-plugin（ZCode author，Apache-2.0）：内容未评估，另行调研。
- 上游 android-emulator / ios-simulator / restore-legacy-sessions / superpowers 插件：与本仓现有能力重叠或场景不符，暂不引。
- Z.ai 插件的可选依赖（Playwright/Tectonic）的离线预置：按「按需 + 询问用户」原则，
  workwin 离线场景后续单独处理。

## 验收场景

1. 全新安装包启动：插件页出现 Documents / PDF / Spreadsheets（Z.ai author、productivity
   分类、默认启用）；技能列表含 `docx`/`pdf`/`xlsx`（插件版）与
   `docx-redline`/`pdf-ops`/`xlsx-ops`（MiniMax 版）、`pptx`，无同名冲突。
2. 路由实测（workwin）：「帮我写一份周报排成 PDF」→ pdf 插件（制作路由）；
   「给这份 PDF 表格填数」→ pdf-ops；「修订这份合同的第 3 条」→ docx-redline；
   「给这份 Excel 做个柱状图」→ xlsx 插件（图表引擎）。意图错配即为 bug。
3. 从零创建 docx 走插件版（docx-js）不报缺失依赖；对存量 docx 跑修订走 MiniMax 版
   C# 链正常。
4. 卸载/禁用插件版后 MiniMax 版技能仍可用（互不依赖）。
5. `pnpm verify:pre-push` 全绿；licenses-notices CI 绿（台账含三个新 Apache-2.0 条目）。
