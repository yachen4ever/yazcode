import type { ServiceAuthorityMode } from "@zcode/shared";

export type ZCodeAgentPresentationSurface = "desktop";

interface ZCodeAgentPresentationHostFacts {
  runtimeSurface?: "desktop_local_host" | "remote_workspace_host";
  serviceAuthorityMode?: ServiceAuthorityMode;
}

export function resolveZCodeAgentPresentationSurface(
  facts: ZCodeAgentPresentationHostFacts,
): ZCodeAgentPresentationSurface | undefined {
  // presentation surface 是呈现宿主的结构性事实，从 Host 已有的可信装配事实推导，
  // 不承担任何服务端灰度裁决。历史上它被 desktop-context-prompt 灰度门禁
  // （desktopContextPromptEnabled === false 时打回 undefined），而灰度在审计版构建里
  // 恒为本地关闭态，导致 zcode_desktop 永不成立——gen-ui P1 的 Interactive views 上下文、
  // 可视化输出目录与 visualize 技能依赖这个 surface，26.2.0 workwin 打包版实测全部失效。
  // 灰度与 env 链已随该缺陷修复整体退役；Desktop prompt 段的内容即由 surface 携带。
  // 普通 HTTP/manual app-server 没有这两个事实，继续保持 terminal，避免把 Desktop prompt 扩散出去。
  const isDesktopHost =
    facts.runtimeSurface === "desktop_local_host" ||
    facts.serviceAuthorityMode === "desktop-attached-remote";
  return isDesktopHost ? "desktop" : undefined;
}
