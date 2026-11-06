import { app } from "electron";
import { stripHostInjectedEnvInPlace } from "@zcode/shared/host-env-boundary";

/**
 * 桌面 main 最早可用点的宿主注入面剥离（deny-by-default）。
 *
 * spec：docs/specs/host-env-injection-boundary.md 契约 3。打包态应用若从宿主 zcode
 * 会话内启动，会继承宿主注入的 ZCODE_/YAZCODE_/ZCODIUM_ 变量——这些变量不受控且随
 * 官方升级变化（mint 双盲 F1 即宿主注入的 builtin 配置副本导致模型配置与浏览器
 * 控制整体不可用）。此处在任何 spawn/消费之前一次性剥离，后续 host 与 agent
 * 子进程继承的都是已洗涤环境。
 *
 * 打包态才剥离：dev 态的显式调试通道（.env 与启动脚本变量）由 dev 链路自己的
 * 原语调用处理，不在此处动用户的显式配置。
 */
export function applyEarlyHostEnvInjectionBootstrap(desktopApp: typeof app = app): void {
  if (!desktopApp.isPackaged) return;
  // 打包态：dev-runtime-only 族（桌面数据隔离目录族、FS 故障注入门控）一并剔除——
  // 它们只在 dev 态是可信的开发者配置，打包态被宿主顶替即改用户数据落盘位置或
  // 打开生产故障注入面（总账 R2/R6 组）。
  stripHostInjectedEnvInPlace(process.env, { allowDevRuntimeKeys: false });
}
