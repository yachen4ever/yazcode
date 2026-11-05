# mint 26.5.2 双盲 F4–F7 处置记录

对应 Gitea agents/handoff issue #9 任务书 F4–F7（建议级）逐项结论。调查基线：
`fix/2652-mint-f1f7`（F1–F3 修复之后）。

## F4 删除双确认——现状即任务书口径，不改代码

核实结论：删除流自引入起就实现了 spec P4 规则 6 的完整双确认
（`packages/ui/src/settings/IabUserscriptRowDetails.tsx`）：

- 框 1（`delete.confirmTitle/confirmMessage`）恒出现，通过后先 patch manifest 移除条目
  （失败即中止、文件保留）；
- 框 2（`delete.storageTitle/storageMessage`「同时删除脚本数据？」）**在
  `row.hasStorageFile === true` 时独立出现**，取消 = 仅删脚本保留存储
  （`deleteStorage: false`）——这正是 spec 明文：「存在 GM 存储文件时第二个确认框
  独立出现」。

mint 实测「一道确认即删除」的被测脚本没有 GM 存储文件，第二道框按 spec 本就不出现。
实现、文案均与任务书口径一致，未改动。若产品上希望删除恒定两步（无存储也终确认），
改动面在 `IabUserscriptRowDetails.tsx` 的 `handleDeleteConfirmed` 分支
（`hasStorageFile ? 框2 : deleteScript(false)`），需先改 spec 再动代码。

**口径决定（2026-11-05）**：维持现状（有 GM 存储才第二道确认），不做恒定两步改动。

## F5 首装自动触发引导——不做（引导系统为审计版已移除模块）

调查结论：设置底部「引导」按钮与快捷键当前是**死链**——审计版移除官方引导
（`packages/ui/src/onboarding/useOnboardingTrigger.ts` 头注释：「官方引导（欢迎页 +
职业调研问卷）已整体移除」）；`OnboardingDialog` 组件仍在但打开链路
（`requestOnboardingDialog`）不可达，唯一 dispatch 方 `OccupationOnboarding` 被禁用。

恢复引导系统属于重新启用已移除模块的产品决策（repo 核心原则：不自行恢复已移除的
模块），超出本修复任务范围，不做。缓解事实：F1 修复后首装不再出现「模型配置加载失败」
死胡同，F5 报告的实际痛点（首装即死路）随 F1 消失。若要重新启用引导，需先立项决定
启用范围（OnboardingDialog 欢迎页 / OccupationOnboarding 迁移向导）与首装触发条件
（`settingsSyncFirstRunPromptHandled` / onboarding record `shouldOnboard` 均可复用）。

**口径决定（2026-11-05）**：不重开引导系统，维持移除现状。

## F6 模型设置重试反馈——静态链路已具备反馈语义，关窗现象待复测，不臆测改代码

调查结论：重试（`ModelProviderSection.tsx` loadError 分支的 `reload`）触发
`useProviderSettingsServiceView` 重读：state 先回 `loading`（整页切回加载壳子），
成功则渲染正常内容、失败回到 error 页（重试按钮仍在）——**加载中/成功/失败反馈在
静态代码上均存在**。重试 handler 不触碰设置层开关（`tabStore.isSettingsTabActive`），
「点击后设置窗口关闭回工作区」与静态代码不符；结构性假说是**整窗 reload**
（设置 tab 不参与持久化恢复，任何整窗刷新都会把用户落回工作区），未证实。

处置：不基于未证实假说改代码。复测指引（F1 修复后的包上）：点重试后看
`[Root] settings view open/closed`（Root.tsx）与 `settings layer visibility changed`
（RootWorkspaceContent.tsx）日志及是否整树 remount——若确认为整窗 reload，
按独立 bug 立项处理。

## F7 右下错误条加手动关闭——实施

`Root.tsx` 的模型配置错误条（`root.modelSelection.loadFailed`，状态驱动、fixed
右下、z-50）原先无关闭按钮、不自动消失，遮住设置页右下「清除缓存」按钮。

行为契约（本报告为该错误条的 spec 落点）：

- 错误条保持状态驱动：`modelSelectionService` 读取恢复成功（error → ready）后自动消失；
- 新增手动关闭按钮（`common.close`，X 图标）：点击仅收起本次错误条，不改变底层读取
  状态（读失败仍在，重试入口保留在设置页模型供应商区块）；
- 点击「重试」同时重置关闭态——用户重新关注后错误条恢复可见；
- 关闭态为会话内 UI 状态（组件 state），不持久化、不进 store（无跨窗口同步需求）。
