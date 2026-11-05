# Spec：Windows 关闭到托盘的托盘就绪门禁

## 背景

mint 26.5.2 后上游引入批 C（ZCodium #77/#92 单点加固，上游 811dc560/128d367b 与官方
3.17.x 同域演化的本仓对齐）。本仓 Windows 托盘语义：`desktopTray.ts` 的
`createWindowsDesktopTray` 非 win32 或 Tray 构造失败时返回 null；`index.ts` 忽略返回
值，`handleDesktopWindowCloseRequest` 在 `win32 ∧ closeToTrayOnWindows ∧ 非 forceQuit
∧ 非显式退出` 时隐藏窗口——**Tray 创建失败（如 Windows 托盘资源耗尽、explorer 异常）
时窗口仍会 hide 到「不存在的托盘」，用户没有任何找回窗口的入口**，只能任务管理器。
门禁语义对齐上游：托盘实例真实创建成功（desktopTrayReady）才允许隐藏到托盘。

## 产品行为

- Windows 下「关闭窗口 → 隐藏到托盘」仅在**托盘图标真实创建成功**后生效；
- 托盘创建失败时，关闭窗口走正常关闭流（末窗退出确认 / 直接退出），窗口保持可找回；
- macOS / Linux 行为不变（本仓托盘本就 Windows-only，macOS 走 dock 语义）；
- `closeToTrayOnWindows` 设置项语义不变（仍可在设置中关闭隐藏到托盘）。

## 实现边界

1. **判定纯函数**：`desktopTrayGate.ts`（electron-free，可直测）导出
   `shouldHideWindowToTray({ platform, closeToTrayOnWindows, closeToTraySupported,
   forceQuit, explicitQuitRequested })`——全部条件与运算，`closeToTraySupported`
   即 `desktopTrayReady`（托盘实例创建成功）。
2. **就绪状态**：`desktopTray.ts` 维护模块级 `desktopTrayReady`，Tray 构造成功置 true、
   失败保持 false，导出 `isDesktopTrayReady()`。
3. **接线**：`handleDesktopWindowCloseRequest` 的 win32 分支改经
   `shouldHideWindowToTray` 裁决；`index.ts` 唯一生产调用点显式传
   `closeToTraySupported: isDesktopTrayReady()`。lifecycle option 缺省 true 保持向后
   兼容（门禁在唯一生产调用点显式接线，遗忘接线时回退旧行为而非静默禁用关闭）。
4. 平台裁决（darwin/末窗确认退出等）不变，仅 win32 hide 分支增加就绪门禁。

## 验收场景

1. win32 + 设置开 + ready + 非 forceQuit/显式退出 → 隐藏到托盘（现状不变）。
2. win32 + 设置开 + **托盘未就绪** → 不隐藏，走正常关闭流（本 spec 新增门禁）。
3. forceQuit / 显式退出 / 非 win32 / 设置关 → 均不隐藏（现状不变）。
4. `desktopTrayGate.test.ts` 覆盖上述真值表；既有 `desktopWindowLifecycle` 行为
   （darwin/末窗确认）不受影响。
