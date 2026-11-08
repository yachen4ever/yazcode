# Spec：全局 toast 的投递与可见性零 rAF 依赖（26.5.6 修复项 1/2）

来源：minttest 五轮（26.5.4）/六轮（26.5.5）双盲连续两轮实测「刷新失败 toast 全程未出现」，
六轮报告钉住超时兜底失效与失败 toast 缺失；mintdev 26.5.6 修复批定位根因并修复。

## 背景（根因）

`packages/ui/src/components/ui/toast.tsx`（全局命令式 toast，全仓约 69 处消费）在两个
环节依赖 `requestAnimationFrame`：

1. **投递**：`toast()` 在 ToastContainer 尚未挂载时用 rAF 循环重试 `addToast`；
2. **可见性**：`ToastMessage` 挂载后用 rAF 把 `visible` 从 false 翻到 true，
   翻转前元素停在 `opacity-0`。

Electron 渲染进程在窗口被遮挡/后台/最小化时 rAF 被节流乃至暂停（实测被遮挡窗口
约 0.2 帧/秒；React 状态渲染走 Scheduler/MessageChannel 不受影响）。由此产生：

- toast 的 DOM 挂载被推迟到下一次 rAF——被遮挡窗口上延迟数秒甚至永不出现；
- 即使挂载，元素停在 `opacity-0`；
- **26.5.5 AppImage 活体复现证实**：同一次刷新里状态圆点转「最近连接失败」正常
  （React 状态），而 toast 内容在 DOM 中 14 秒不出现；窗口恢复可见后 toast 才
  （有时）补放出来。这与两轮双盲「保存反馈卡（React 状态渲染）始终可见、
  全局 toast 从未被观测到」的全部现象吻合。

mintdev 三环境对照（同一 commit）：dev web（Chromium 前台）✅ 正常、生产 bundle
preview（Electron 纯浏览器窗口前台）✅ 正常、26.5.5 AppImage（CDP 驱动、窗口遮挡）
❌ 间歇性丢失——隔离出「渲染管线 × 窗口可见性」这一变量。

## 行为规则

1. **投递零 rAF**：`toast()` 同步入投递控制器（`toastDelivery.ts`）——接收方
   （ToastContainer）就绪则立即送达；未就绪则缓冲，容器挂载时同步排空
   （React 初始挂载走 Scheduler，不随窗口可见性停摆）。预挂载的
   `updateToast`/`dismissToast` 语义不变（合并更新、丢弃待投递项）。
2. **可见性挂载即见**：`ToastMessage` 初始即处于可见态；进入动画改为 CSS
   keyframes（`zcode-toast-in`，`motion-safe` 下生效），帧产出时自然播放——
   不再把「能不能看见」押在 rAF 上。退出仍走 leaving 态 + transition + 计时器
   （setTimeout 在后台窗口被节流只影响消失时机，不影响出现）。
3. **语义不变项**：位置/variant/dedupeKey/anchorId/dismissible、自动消失时长、
   去重与锚定栈行为全部保持；前台正常场景下的视觉与交互不回退。
4. **回归守卫**：源级断言 `toast.tsx` 不含 `requestAnimationFrame`；投递控制器
   缓冲/排空/立即送达语义直测（`toastDelivery.test.ts`）。

## 验收

1. 前台窗口：toast 立即出现并播放进入动画，3s 自动消失（视觉同旧）；
2. 被遮挡/后台窗口（CDP 驱动 AppImage，不抬窗）：点击刷新后 toast 文案在 DOM 与
   无障碍树中立即可见（≤1s），不再依赖窗口抬升；
3. 模型设置页两路失败反馈（`refreshFailed` 聚合失败、`connectivityCheckFailed`
   探测失败）在上述两态下均可见；
4. `pnpm --filter @zcode/ui test` 全绿（含新增投递契约与源级断言）。
