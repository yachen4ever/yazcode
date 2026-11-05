/**
 * Windows「关闭到托盘」裁决纯函数（electron-free，spec 见
 * packages/desktop/specs/desktop-tray-close-gate.md）。
 * 门禁语义：托盘实例真实创建成功（closeToTraySupported = desktopTrayReady）才允许
 * 隐藏到托盘——Tray 创建失败时窗口若仍 hide，用户没有任何找回窗口的入口
 * （上游 ZCodium #77/#92 与官方 3.17.x 同域加固的本仓对齐）。
 */
export function shouldHideWindowToTray(options: {
  platform: NodeJS.Platform;
  closeToTrayOnWindows: boolean;
  closeToTraySupported: boolean;
  forceQuit: boolean;
  explicitQuitRequested?: boolean;
}): boolean {
  return (
    options.platform === "win32" &&
    options.closeToTrayOnWindows &&
    options.closeToTraySupported &&
    !options.forceQuit &&
    !options.explicitQuitRequested
  );
}
