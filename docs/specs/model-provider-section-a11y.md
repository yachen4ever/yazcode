# Spec：模型设置页 UX——接入端点开关可访问性 + 手动刷新反馈（26.5.4 增补批 ③）

来源：minttest 四轮双盲 UX 池两项实测痛点（agent-handoff #16 第四轮报告）。

## 1. 接入端点启用开关的 aria 语义（3b）

### 背景

minttest 四轮实测：「模型列表每一行同时存在『禁用』与『启用』两个开关，aria 标签随
状态在两个词之间切换（同一元素两种文案），首次配置极易误操作」。

调查结论（2026-11-07，`InlineEditableProviderCard.tsx` providerToggle）：实际只有
**一颗 Switch**（`role="switch"`，provider 卡片头部）——「两个开关」是 aria 快照的
呈现假象：同一元素的 accessible name 随状态在「启用接入端点 / 禁用接入端点」两个
动作文案间翻转，快照工具把两种形态都呈现出来，读作两个控件。

### 语义定案（ARIA switch 模式）

- **accessible name 必须稳定**：name 是「这个开关是什么」（控件主体），**状态由
  `aria-checked` 表达**，二者不得混用。name 随状态翻转会让读屏输出自相矛盾
  （「禁用接入端点，已开启」），也是快照工具呈现为双开关的根因。
- 落地：`aria-label = "{name} 启用开关"`（`settings.modelProvider.providerToggleAria`，
  name = provider 显示名），任意状态下不变；`checked={provider.enabled}` 继续承载状态。
- **视觉 tooltip 保留动作文案**（「启用接入端点/禁用接入端点」）：对看得见的用户，
  「点击将发生什么」是有效的操作预告；仅 accessible name 改稳定语义。视觉与读屏
  双通道各取所需，不互相迁就。

### 验收

1. 同一开关在 enabled 两种状态下 aria-label 逐字相同（快照不再出现双开关形态）；
2. `aria-checked` 随状态翻转（状态可被读屏/快照正确读取）；
3. tooltip 文案仍随状态给动作预告。

## 2. 手动刷新的结果反馈（3a）

### 背景

minttest 四轮实测：「模型页有『刷新』按钮但无任何反馈（无 loading/结果提示），空列表
时无法判断是否真的刷新过」。

调查结论：按钮 loading 链路在当前 main 已存在（`useModelProviders.refreshing` →
`SectionLayout` 刷新按钮 loading + 文案切换，含 token 守卫防连续刷新闪灭）；缺口是
**失败不可见**——`refresh()` 内部 catch 只落 logger，手动刷新失败时 UI 无任何呈现；
成功场景按产品语义保持静默（列表变化本身就是反馈）。

### 行为规则

1. **loading**：维持既有链路（`modelProvidersRefreshing` 驱动），不新增第二 loading
   事实源。
2. **失败可见**：手动刷新链路（`refreshModelProviderSection`）把「provider list
   refresh 与 Team Plan 快照刷新」的成败聚合为布尔结果；任一失败（含 Promise 拒绝）
   由调用方呈现失败 toast（`settings.modelProvider.refreshFailed`，三语）。
3. **成功静默**：成功不弹提示（列表/快照内容变化即反馈），避免高频成功噪音。
4. **后台刷新不弹 toast**：`refresh()` 的失败上报只在手动刷新入口呈现；auth 变更等
   后台流（`refreshProviderPanelAfterAuthChange`）维持 logger 记录，不打扰。

### 验收

1. 断网/后端不可用时点「刷新」→ 出现失败 toast，按钮 loading 正常结束；
2. 正常网络点「刷新」→ 无成功 toast，列表内容更新；
3. `refreshModelProviderSection` 聚合语义可直测：双成功 = true、任一失败 = false、
   teamPlan 缺席 = 仅看 provider refresh。
