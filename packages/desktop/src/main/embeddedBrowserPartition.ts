/**
 * IAB guest 会话分区的唯一命名源。独立成 electron-free 模块：
 * 判定语义（如用户脚本 IPC 的分区校验）需要被 node:test 直测，
 * 不能挂在顶层 import electron 的 browserDataManager 上。
 */
export const EMBEDDED_BROWSER_PARTITION = "persist:zcode-embedded-browser";
