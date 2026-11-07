import { CircleIcon } from "lucide-react";
import { createContext, useContext } from "react";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 最近一次手动刷新连通性探测失败的 providerId 集合（26.5.5 发现 1）。
 * 由 ModelProviderSection 持有状态、SectionLayout 经 Context 下发——导航层级深，
 * props 穿透要改 4 层签名，Context 一处消费零穿透；无 Provider 时为空集（指示器
 * 独立可用，语义不变）。
 */
export const ProviderConnectivityStatusContext = createContext<ReadonlySet<string>>(new Set());

const presentation = {
  disabled: { label: "settings.modelProvider.disabledStatus", color: "text-foreground-subtlest" },
  // 探测失败（unreachable）：纯内存观测事实，与「配置就绪」（executable）正交——
  // 配置完整但连不上时如实标注，不互相污染。
  unreachable: { label: "settings.modelProvider.unreachableStatus", color: "text-warning" },
  unavailable: { label: "settings.modelProvider.unavailableStatus", color: "text-warning" },
  ready: { label: "settings.modelProvider.readyStatus", color: "text-success" },
} as const;

export function ProviderStatusIndicator({
  provider,
}: {
  provider?: Pick<ProviderSettingsFormProvider, "providerId" | "enabled" | "executable"> | null;
}) {
  const { intl } = useZCodeIntl();
  const unreachableProviderIds = useContext(ProviderConnectivityStatusContext);
  const unreachable = provider ? unreachableProviderIds.has(provider.providerId) : false;
  // 只做展示映射，不能在 UI 再检查 Key、权益或模型成员。
  // 优先级 disabled > unreachable（最近连接失败）> 就绪/未就绪。
  const status =
    provider?.enabled === false
      ? "disabled"
      : unreachable
        ? "unreachable"
        : provider?.executable
          ? "ready"
          : "unavailable";
  const { label, color } = presentation[status];
  return (
    <CircleIcon
      data-provider-status={status}
      aria-label={intl.formatMessage({ id: label })}
      className={`size-2 shrink-0 fill-current max-md:absolute max-md:end-1 max-md:bottom-1 max-md:rounded-full max-md:ring-2 max-md:ring-card ${color}`}
    />
  );
}
