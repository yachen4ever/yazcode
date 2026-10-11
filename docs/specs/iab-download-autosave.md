# Spec：IAB（内嵌浏览器）下载静默落盘

## 背景

IAB 会话内触发文件下载时，若未注册 will-download 处理器，Electron 弹原生
「另存为」对话框，agent 流程被卡死（26.0.2 前的实际事故）。

## 行为规则

1. 在 `persist:zcode-embedded-browser` partition 的 session 上注册
   `will-download`：**一律静默保存**到 `Downloads/yazcode/`（用户下载目录下固定
   子目录），重名自动加序号，不弹任何对话框。
2. **fail-open**：目录创建等异常时**不**调用 `setSavePath`，回退 Electron 默认
   对话框——宁可弹窗，不可让下载丢失。
3. 注册点：app ready 后对 `session.fromPartition('persist:zcode-embedded-browser')`
   注册一次即全局生效——IAB 的 webview 用的就是同一 session，**不必追每个
   webview 创建点**。
4. 下载完成/中断状态落服务日志（info 级），不写敏感 URL 之外的凭据内容。

## 状态所有者

- 唯一实现：`packages/desktop/src/main/desktopIabDownloadAutoSave.ts`（main 进程）。
- 下载目录展示/打开仍走既有 `IPlatformService` 能力，本模块不新增平台接口。

## 不变量

1. 任何情况下不出现「下载被静默丢弃」：失败路径必须回退到用户可见的默认行为。
2. 只作用于 IAB 的 partition session，不影响主窗口/外部浏览器默认下载行为。

## 验收场景

1. IAB 内点击下载 → 文件出现在 `Downloads/yazcode/`，无对话框。
2. 同名文件重复下载 → 自动加序号共存。
3. 下载目录不可写（模拟）→ 弹出默认「另存为」，下载可完成。
4. 主窗口常规下载行为不经过该模块（回归不变）。
