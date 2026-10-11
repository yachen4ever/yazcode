import { useCallback, useMemo } from "react";
import { isApiKeyAccess } from "@zcode/provider";
import type { VisionFallbackSettings } from "@zcode/shared";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  getProviderFormLabel,
  type ProviderSettingsFormProvider,
} from "@/lib/providerSettingsFormTypes.js";
import { logger } from "@/logger.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

/**
 * 「视觉桥接」卡片：主模型不支持图片输入时，把消息中的图片交给 fallback 视觉模型
 * 转成文字描述后重试。fallback 模型从**本地已配置且勾选了图片输入（supportsImage）**
 * 的模型中选择——未勾选视觉能力的模型没有桥接价值，不出现在候选里。
 */

interface VisionBridgeProviderOption {
  providerId: string;
  label: string;
}

export function VisionBridgeSettingsCard({
  modelProviders,
  value,
  onChange,
}: {
  modelProviders: ProviderSettingsFormProvider[];
  value: VisionFallbackSettings | undefined;
  onChange: (next: VisionFallbackSettings) => void;
}) {
  const { intl } = useZCodeIntl();

  const enabled = value?.enabled === true;

  const providerOptions = useMemo<VisionBridgeProviderOption[]>(() => {
    return modelProviders
      .filter(
        (provider) =>
          isApiKeyAccess(provider.config.access) &&
          typeof provider.config.api?.baseUrl === "string" &&
          provider.config.api.baseUrl.trim().length > 0 &&
          typeof provider.config.api?.type === "string" &&
          provider.config.api.type.length > 0,
      )
      .map((provider) => ({
        label: getProviderFormLabel(provider),
        providerId: provider.providerId,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [modelProviders]);

  const selectedProvider = useMemo(
    () =>
      providerOptions.find((option) => option.providerId === value?.providerId) ?? null,
    [providerOptions, value?.providerId],
  );

  /** 本地已配置且勾选了图片输入的模型（按 provider 分组）；未勾视觉的模型没有桥接价值。 */
  const visionCapableModels = useMemo(() => {
    const byProvider = new Map<string, string[]>();
    for (const provider of modelProviders) {
      if (!isApiKeyAccess(provider.config.access)) continue;
      const capable = provider.models
        .filter(
          (model) =>
            model.executable !== false &&
            model.config.properties?.inputFormat?.supportsImage === true,
        )
        .map((model) => model.modelId);
      if (capable.length > 0) byProvider.set(provider.providerId, capable);
    }
    return byProvider;
  }, [modelProviders]);

  const modelChoices = useMemo(() => {
    const models = (value?.providerId && visionCapableModels.get(value.providerId)) || [];
    // 已存的 modelId 若后来被取消勾选视觉，仍保留显示，避免保存值被静默丢弃。
    const current = value?.modelId;
    if (current && !models.includes(current)) {
      return [current, ...models];
    }
    return models;
  }, [visionCapableModels, value?.providerId, value?.modelId]);

  const handleProviderChange = useCallback(
    (providerId: string) => {
      // 切换 provider 后原模型 id 不再可信，清空让用户重选。
      onChange({ ...value, enabled: value?.enabled === true, modelId: undefined, providerId });
    },
    [onChange, value],
  );

  const handleModelChange = useCallback(
    (modelId: string) => {
      onChange({ ...value, enabled: value?.enabled === true, modelId });
    },
    [onChange, value],
  );

  const enableLabel = intl.formatMessage({ id: "settings.visionBridge.enable" });
  return (
    <SettingsGroupCard>
      <div className="px-4 pb-2 pt-4">
        <div className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.visionBridge.title" })}
        </div>
        <div className="mt-2 text-ui-sm text-muted-foreground">
          {intl.formatMessage({ id: "settings.visionBridge.description" })}
        </div>
      </div>
      <SettingsRow
        label={enableLabel}
        description={intl.formatMessage({ id: "settings.visionBridge.enableDesc" })}
        control={
          <Switch
            aria-label={enableLabel}
            checked={enabled}
            onCheckedChange={(checked) => onChange({ ...value, enabled: checked })}
          />
        }
      />
      {enabled ? (
        <>
          <SettingsRow
            label={intl.formatMessage({ id: "settings.visionBridge.provider" })}
            control={
              <Select
                value={value?.providerId ?? ""}
                onValueChange={handleProviderChange}
              >
                <SelectTrigger className="w-full justify-between" size="lg">
                  <SelectValue
                    placeholder={intl.formatMessage({
                      id: providerOptions.length > 0
                        ? "settings.visionBridge.providerPlaceholder"
                        : "settings.visionBridge.noProviders",
                    })}
                  />
                </SelectTrigger>
                <SelectContent align="start">
                  {providerOptions.map((option) => (
                    <SelectItem key={option.providerId} value={option.providerId}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
          <SettingsRow
            label={intl.formatMessage({ id: "settings.visionBridge.model" })}
            description={intl.formatMessage({ id: "settings.visionBridge.modelDesc" })}
            control={
              <Select
                disabled={!selectedProvider}
                value={value?.modelId ?? ""}
                onValueChange={handleModelChange}
              >
                <SelectTrigger className="w-full justify-between" size="lg">
                  <SelectValue
                    placeholder={intl.formatMessage({
                      id: "settings.visionBridge.modelPlaceholder",
                    })}
                  />
                </SelectTrigger>
                <SelectContent align="start">
                  {modelChoices.map((modelId) => (
                    <SelectItem key={modelId} value={modelId}>
                      {modelId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
          {selectedProvider && modelChoices.length === 0 ? (
            <div className="px-4 pb-3 text-ui-sm text-muted-foreground">
              {intl.formatMessage({ id: "settings.visionBridge.modelsEmpty" })}
            </div>
          ) : null}
        </>
      ) : null}
    </SettingsGroupCard>
  );
}
