# Spec：发版顺序（实机验收 → 打 tag → 发 release）

## 背景

26.2.0 的实际发版顺序是「先 `git push` + 打 tag，CI 从远端 tag 构建并发布 release，
再在 workwin 装包验收」。这带来两个问题：

1. **验收结论无处追溯**。release 已经公开可下载，验收若不通过则产物已流出，只能另发
   修正版；26.2.0 的验收清单（五项）最终没有留下「通过 / 未通过」的记录。
2. **tag 与 release 语义混淆**。远端 tag 存在不等于 release 已发布——26.1.2 就是
   tag 已推送、但因 linux-arm64 产物缺失导致 release 停在 draft，从未公开发布。

## 行为规则

1. **实机验收先于打 tag**。需要实机验收的版本，先在验收机装出安装包并按验收清单
   逐项确认，**验收通过**后才允许推送 tag 并触发 release。
2. **双盲测试先于实机部署验收**（26.5.2 轮起固化的顺序）。标准发版顺序为：
   **构建 draft release（不公开）→ mint 双盲测试（黑盒使用 draft 产物，报告按
   严重/一般/建议分级）→ workwin 实机部署验收（A/B/C 分组）→ 全部通过后转
   official**。双盲在低成本环境先暴露产品面缺陷，其发现转修复批（修复合 main 后
   重新构建 draft 进入下一轮双盲，如 26.5.2 的 S1 → F1-F7 两轮）；双盲不替代
   实机验收，两者都通过才允许公开发布。
3. **tag 与 release 是两个独立状态**，任何一个都不代表另一个：
   - tag 已推送、release 处于 draft = **未发布**，不得对外宣称该版本可用。
   - release 已发布 = 产物已公开可下载，验收必须已完成。
4. **验收结论必须落成可追溯记录**。验收清单的逐项结论（通过 / 未通过 / 未执行及原因）
   写入对应版本的 CHANGELOG 条目或验收记录文件，不停留在会话记忆里。
5. **未公开发布的版本要在 CHANGELOG 里显式说明**，写明未发布原因与内容归属哪个版本
   交付。26.1.2 即属此类：内容随 26.1.3 一并交付。
6. **验收机安装包与发布产物是两份**。验收用本机构建或 CI 产出的安装包；最终发布
   产物由 CI 从远端 tag 构建。二者版本号一致，但不是同一个文件。验收结论对同一
   提交负责，不因产物来源不同而失效。

## 不变式

- 「release 已发布」与「该版本已验收」必须同时为真，才可以说「该版本可用」。
- 任一平台产物缺失 → release 保持 draft（由 `.github/workflows/release.yml` 的
  `publish` job 依赖关系保证，不额外加门禁）。此时该版本按「未发布」处理。

## 与既有门禁的关系

- `pnpm verify:pre-push`（Lint + 根包 typecheck + 架构检查 + 技能残留 + db schema 契约 + build:cli + CLI 类型检查 + 全量测试）覆盖**提交前**
  的代码门禁，不覆盖实机验收。
- `pnpm typecheck:cli` 需在 CLI 依赖包构建之后执行（`build:zcode` → `typecheck:cli`），
  与 release.yml 的 job 顺序一致；冷检出直接跑会因缺 `dist` 报模块找不到。

## 仓库拓扑与发版推送（2026-11-07 双轨定案）

- **主仓/真相源** = 内网 Gitea `yaclab/yazcode`（日常 pull/push、任务书 issue、fork+PR
  闭环）；**GitHub `yachen4ever/yazcode` = 发版镜像**——仅在发版时由 leader 推送
  main + tag，用于触发 Actions 构建（`workflow_dispatch`）与承载 release 资产。
- 发版推送顺序：内网 main 合入全部批次 → `git push github main --follow-tags` →
  `gh workflow run release.yml -f version=<x> -f keep_draft=true`（双盲测试期产物
  不公开）→ 双盲+实机验收全 PASS 后转 official。
- `upstream-audit.yml` 定时审计与 release 下载仍留在 GitHub，审计信号随发版 push
  刷新（频次语义变化已接受：审计按轮次人工调研为主，30 分钟 issue 为辅助）。

## 验收场景

1. 需要实机验收的版本：验收未通过 → 不得推送 tag、不得触发 release。
2. release 处于 draft 而 tag 已存在 → 记为「未发布」，不计入已交付版本。
3. 版本发布后 → CHANGELOG 或验收记录里有该版本的逐项验收结论。
4. 未公开发布的版本 → CHANGELOG 有显式说明与内容归属版本。
5. 双盲发现缺陷 → 修复合 main 后重新构建 draft 进入下一轮双盲，原 draft 产物不公开、
   不部署实机（26.5.2 实例：S1/F1-F7 两轮）。
