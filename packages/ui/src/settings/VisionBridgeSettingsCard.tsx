import { useCallback, useMemo, useState } from "react";
import { Loader2Icon, Radar } from "lucide-react";
import { isApiKeyAccess } from "@zcode/provider";
import type { VisionFallbackSettings } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useServices } from "@/hooks/useServices.js";
import {
  getProviderFormLabel,
  type ProviderSettingsFormProvider,
} from "@/lib/providerSettingsFormTypes.js";
import { logger } from "@/logger.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

/**
 * 「视觉桥接」卡片：主模型不支持图片输入时，把消息中的图片交给 fallback 视觉模型
 * 转成文字描述后重试。模型选择复用「检测可用模型」链路（listRemoteModels），
 * 只允许从所选 provider 的真实模型清单中点选，不允许手填不存在的 id。
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
  const { providerSettingsService } = useServices();
  const [detectedModels, setDetectedModels] = useState<string[] | null>(null);
  const [detectionPending, setDetectionPending] = useState(false);
  const [detectionError, setDetectionError] = useState<string | null>(null);

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

  const selectedProviderForDetection = useMemo(() => {
    if (!value?.providerId) return null;
    return modelProviders.find((provider) => provider.providerId === value.providerId) ?? null;
  }, [modelProviders, value?.providerId]);

  const modelChoices = useMemo(() => {
    const current = value?.modelId;
    const models = detectedModels ?? [];
    if (current && !models.includes(current)) {
      return [current, ...models];
    }
    return models;
  }, [detectedModels, value?.modelId]);

  const handleDetect = useCallback(async () => {
    const provider = selectedProviderForDetection;
    const api = provider?.config.api;
    if (!provider || !api?.baseUrl || !api.type || !isApiKeyAccess(provider.config.access)) {
      return;
    }
    setDetectionPending(true);
    setDetectionError(null);
    try {
      const result = await providerSettingsService.listRemoteModels({
        apiType: api.type,
        baseUrl: api.baseUrl,
        ...(api.allowInsecureTls ? { allowInsecureTls: true } : {}),
        apiKey: provider.config.access.apiKey ?? null,
        ...(api.headers ? { headers: api.headers } : {}),
        ...(api.tlsCaPath ? { tlsCaPath: api.tlsCaPath } : {}),
      });
      if (result.success) {
        setDetectedModels([...result.models]);
      } else {
        setDetectionError(result.message);
      }
    } catch (error) {
      logger.warn("[VisionBridgeSettingsCard] 检测可用模型失败", { error });
      setDetectionError(error instanceof Error ? error.message : String(error));
    } finally {
      setDetectionPending(false);
    }
  }, [providerSettingsService, selectedProviderForDetection]);

  const handleProviderChange = useCallback(
    (providerId: string) => {
      // 切换 provider 后原模型 id 不再可信，连同已检测清单一起清空。
      setDetectedModels(null);
      setDetectionError(null);
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
              <div className="flex items-center gap-2">
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
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!selectedProviderForDetection || detectionPending}
                  onClick={() => {
                    void handleDetect();
                  }}
                >
                  {detectionPending ? (
                    <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Radar className="size-3.5" aria-hidden="true" />
                  )}
                  {intl.formatMessage({ id: "settings.modelProvider.detectModels" })}
                </Button>
              </div>
            }
          />
          {detectionError ? (
            <div className="px-4 pb-3 text-ui-sm text-destructive" role="alert">
              {detectionError}
            </div>
          ) : null}
          {selectedProvider && modelChoices.length === 0 && !detectionError ? (
            <div className="px-4 pb-3 text-ui-sm text-muted-foreground">
              {intl.formatMessage({ id: "settings.visionBridge.modelsEmpty" })}
            </div>
          ) : null}
        </>
      ) : null}
    </SettingsGroupCard>
  );
}
