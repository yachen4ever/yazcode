/**
 * Renderer tab 上报准入判定（electron-free，供 browserGuestManager 与单测共用）。
 *
 * 抽成独立模块的原因：browserGuestManager 顶层 import electron，node:test 下无法
 * 加载；仓库既有惯例是把可单测的判定逻辑放进无 electron 依赖的模块
 * （参照 browserCommandCookiesHandler）。
 */

export interface RendererTabIdentity {
  tabId: string;
  lifecycle: string;
}

/**
 * 迟到 residency 上报判定（ZCodium #66 同型）：面板关闭 / 切 tab 后 renderer 可能
 * 还有一次在途上报，此时 tab 已被移除或标记 closed——迟到上报没有状态可写，静默
 * 丢弃，避免 Electron 把 IPC handler 的 throw 记成 main process 错误。
 * 作用域不匹配不在此处处理，仍交给严格校验抛错。
 */
export function isLateRendererTabReport(tab: RendererTabIdentity | undefined): boolean {
  return !tab || tab.lifecycle === "closed";
}
