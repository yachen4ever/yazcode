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

## 3. 手动刷新的连通性复核（26.5.5 发现 1）

### 背景（26.5.4 五轮实测 + 根因修正）

minttest 五轮：把 MiniMax Base URL 改为不可达地址后点顶部「刷新」，四时点均无
loading/失败 toast。**26.5.4 增补批 3a 的聚合与失败 toast 已在顶部按钮生效**（任务书
「顶部按钮未覆盖」的定位不成立——`ModelProviderSection.onRefresh` 即聚合入口）；现象的
真实根因是**刷新语义**：`refresh()` 重读本地设置视图，从不产生网络失败，toast 永远
没有失败源；导航绿点（`ProviderStatusIndicator`）是「配置就绪」指示
（enabled ∧ executable），与连通性无关，端点不可达后依旧绿色。

### 行为规则

1. **连通性探测**：手动刷新（且仅手动刷新）时，对每个 `enabled ∧ executable` 且存在
   首个可用模型（`config.enabled !== false ∧ executable`）的 provider，经既有
   `testModelConnectivity` 通道探测该模型（产品既定连接语义，无 API 格式假设）。
   单探测 10s 超时兜底（黑洞挂起不得把刷新拖过 10s）；各 provider 并发。
2. **聚合成败**：探测返回 `success !== true`、抛错或超时 → 该 provider 计入失败集；
   失败集非空 → 失败 toast（`connectivityCheckFailed`，三语）；全部成功 → 静默
   （列表内容变化即反馈）。
3. **绿点如实标注**：探测失败的 provider 在导航圆点呈 warning「最近连接失败」
   （新状态 `unreachable`，优先级 disabled > unreachable > ready/unavailable）。
   探测结果是纯内存观测事实（随下一次手动刷新整体重置），不写 provider 配置——
   「配置就绪」与「连接可用」两个维度保持正交，不互相污染。
4. **无可用模型的 provider 不探测**：没有可发起调用的模型，探测无从谈起，
   也不产生失败。

### 验收

1. 连接拒绝（如 `127.0.0.1:9`）→ 刷新后失败 toast + 该端点导航点「最近连接失败」；
2. 黑洞挂起（如 `10.255.255.1`）→ ≤10s 刷新结束并呈现失败（loading 期间即有反馈）；
3. 正常端点 → 静默 + 圆点维持；
4. `probeProviderConnectivity` 聚合可直测：成功/失败/超时/跳过禁用与无可用模型。

## 4. 模型行启用开关的 aria 语义（26.5.5 发现 2）

26.5.4 五轮实测：启用中的模型行开关 aria=「禁用」而 checked=true——与 §1 同根：
`ModelRowInput` 的 Switch accessible name 随状态在 `enableAction`/`disableAction`
动作文案间翻转，读屏语义与真实状态相反。按 §1 同一 ARIA switch 模式修正：

- aria 固定为「{name} 启用开关」（name = modelId，`modelToggleAria`，三语），
  状态由 `aria-checked` 承载；
- `enableAction` / `disableAction` 两个 key 随之成为死键，**一并移除**（不留第二种
  翻转文案的复活入口）。

验收：行开关 aria 与 §1 的端点开关同一模式（name 稳定、状态在 aria-checked）；
源级断言不再出现状态翻转的三元文案。

## 5. 连通性状态圆点的转换语义（26.5.6 修复项 4）

背景（minttest 六轮实测补入观察）：端点转「最近连接失败」后，恢复正确 URL 再刷新，
28s 采样圆点仍停留失败态——失败方向可见，恢复方向无转换。

语义定案（`unreachableProviderIds` 的完整生命周期，状态所有者 =
`ModelProviderSection` 本地 state，经 `ProviderConnectivityStatusContext` 下发）：

```
手动刷新 ──► probeProviderConnectivity（对当前已保存配置并发探测）
                │
                ├─ provider 探测失败/超时/抛错 ──► 计入失败集
                └─ provider 探测成功            ──► 不计入
                │
                ▼
        整集替换 setState（不是增量合并）
                │
                ├─ 失败集非空 ──► 圆点 unreachable（warning「最近连接失败」）+ 失败 toast
                └─ 失败集为空 ──► 圆点回 ready/unavailable（回绿）＋ 静默
```

1. **整集替换、无记忆**：每次手动刷新的探测结果整体替换上一次失败集——上一轮
   失败的 provider 本轮探测成功即回绿；探测成功路径与失败路径是同一跳
   （同一 `setState`），不允许只实现失败方向。
2. **探测挂起期间保留旧态**：新一轮探测进行中不清空旧失败集（避免橙→绿→橙闪烁）；
   探测完成一次性落新态。10s 超时兜底保证旧态最多滞留 ~10s。
3. **成功静默**：回绿本身即反馈，不弹成功 toast（与 §2/§3 成功口径一致）。
4. **不写持久化**：unreachable 是纯内存观测，应用重启即清（配置就绪维度仍由
   `executable` 承载，两维度正交不变）。

验收：失败 URL → 刷新 → 橙（「最近连接失败」）；恢复正确 URL（保存落盘）→ 刷新 →
≤10s 回绿且无成功 toast；`probeProviderConnectivity` 成功返回空集已有直测覆盖。
