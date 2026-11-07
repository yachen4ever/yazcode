import type { ConfirmDialogRequest } from "@/store/confirmDialogStore.js";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import { getProviderFormLabel } from "@/lib/providerSettingsFormTypes.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
export async function confirmAndDeleteModelProvider({
  provider,
  confirmDialog,
  intl,
  deleteProvider,
}: {
  provider: ProviderSettingsFormProvider;
  confirmDialog: (payload: ConfirmDialogRequest) => Promise<boolean>;
  intl: IntlInstance;
  deleteProvider: (providerId: string) => Promise<void>;
}) {
  if (provider.config.group === "zai-family" || provider.config.group === "bigmodel-family") {
    return;
  }

  logger.info("[ModelProviderSection] 请求删除自定义模型供应商", {
    providerId: provider.providerId,
    providerName: getProviderFormLabel(provider),
  });

  const confirmed = await confirmDialog({
    title: intl.formatMessage(
      { id: "settings.modelProvider.deleteConfirmTitle" },
      { name: getProviderFormLabel(provider) },
    ),
    description: intl.formatMessage({
      id: "settings.modelProvider.deleteConfirmDescription",
    }),
    confirmLabel: intl.formatMessage({
      id: "settings.modelProvider.deleteConfirmAction",
    }),
    cancelLabel: intl.formatMessage({ id: "common.cancel" }),
  });
  if (!confirmed) {
    logger.info("[ModelProviderSection] 用户取消删除自定义模型供应商", {
      providerId: provider.providerId,
      providerName: getProviderFormLabel(provider),
    });
    return;
  }

  try {
    await deleteProvider(provider.providerId);
  } catch (error) {
    logger.error("[ModelProviderSection] 删除模型供应商失败", error);
  }
}

export async function refreshModelProviderSection({
  refresh,
  refreshTeamPlanProducts,
}: {
  /** 返回本次 provider list 刷新是否成功（失败已在 hook 内吞错保 logger）。 */
  refresh: () => Promise<boolean>;
  refreshTeamPlanProducts?: () => Promise<void>;
}): Promise<boolean> {
  // Model Provider 顶部刷新是账号权益刷新入口。
  // Team Plan 连接方式来自企业 pricing/customerInfo，不会被普通 provider list refresh 更新。
  // 聚合成败（26.5.4 增补批 ③a）：任一失败（含拒绝）= false，调用方呈现失败反馈；
  // 成功保持静默（列表变化即反馈）。teamPlan 缺席 = 仅看 provider refresh。
  try {
    const results = await Promise.all([refresh(), refreshTeamPlanProducts?.()]);
    return results.every((value) => value !== false);
  } catch {
    // teamPlan 刷新拒绝（Promise.all 快速失败）：provider list 可能仍已成功，
    // 但手动刷新入口按「有失败须可见」口径统一呈现失败反馈。
    return false;
  }
}

export async function refreshProviderPanelAfterAuthChange({
  refreshModelProviders,
  refreshCodingPlanEntitlements,
  refreshTeamPlanProducts,
  refreshCodingPlanProducts,
  refreshPurchaseTokenState,
  refreshPlanSnapshots = true,
}: {
  // refresh 返回值放宽为 boolean | void（26.5.4 ③a）：refresh 现在回报成败供手动
  // 刷新入口呈现失败反馈；后台流（本函数）忽略返回值，语义不变。
  refreshModelProviders: () => Promise<boolean | void>;
  refreshCodingPlanEntitlements: () => Promise<void>;
  refreshTeamPlanProducts: (options?: { force?: boolean }) => Promise<void>;
  refreshCodingPlanProducts: () => void;
  refreshPurchaseTokenState: () => Promise<unknown>;
  refreshPlanSnapshots?: boolean;
}): Promise<void> {
  await refreshPurchaseTokenState();
  if (refreshPlanSnapshots) {
    await Promise.all([
      refreshModelProviders(),
      refreshCodingPlanEntitlements(),
      refreshTeamPlanProducts({ force: true }),
    ]);
  } else {
    // 切换连接方式只是保存本地连接选择和刷新目标 provider key。
    // 不能顺手刷新今日余额/套餐快照，否则 Start Plan balance 与 entitlement 查询会并发放大。
    await refreshModelProviders();
  }
  refreshCodingPlanProducts();
}
