import { useCallback, useEffect, useMemo, useState } from "react";
import { LoaderCircle, ShieldQuestion } from "lucide-react";
import type { AppSettings, IabUserscriptStatusItem } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import {
  buildIabUserscriptRows,
  nextManifestEntry,
  type IabUserscriptBadgeKind,
} from "@/settings/iabUserscriptsCardPresentation.js";

/**
 * IAB 用户脚本设置卡（P2，契约见 docs/specs/iab-userscripts.md）：
 * - 开关/批准动作只经 useSettings() 的 SettingService patch（manifest 唯一写路径），
 *   开 = 用户批准（{enabled:true}，下次扫描锚定），关 = 禁用或驳回待批准；
 * - 实时状态（name/当前 hash/损坏态）来自可选平台方法 getIabUserscriptStatus（只读
 *   投影）；无宿主环境（普通 Web）降级为 manifest 派生行，不猜测扫描事实。
 */

const BADGE_MESSAGE_IDS: Record<IabUserscriptBadgeKind, string> = {
  serving: "settings.userscripts.status.serving",
  enabled: "settings.userscripts.status.enabled",
  hash_mismatch: "settings.userscripts.status.hashMismatch",
  pending_approval: "settings.userscripts.status.pendingApproval",
  parse_failed: "settings.userscripts.status.parseFailed",
  grant_rejected: "settings.userscripts.status.grantRejected",
  storage_corrupt: "settings.userscripts.status.storageCorrupt",
  disabled: "settings.userscripts.status.disabled",
};

const DEGRADED_BADGE_CLASS = "bg-surface text-foreground-subtle";
const WARN_BADGE_CLASS = "bg-warning/15 text-warning";
const BADGE_KINDS_WARN: readonly IabUserscriptBadgeKind[] = [
  "hash_mismatch",
  "parse_failed",
  "grant_rejected",
  "storage_corrupt",
];

export function IabUserscriptsSettingsCard() {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const { settings, update } = useSettings();
  const [liveStatus, setLiveStatus] = useState<IabUserscriptStatusItem[] | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [pendingScriptIds, setPendingScriptIds] = useState<Set<string>>(new Set());

  const statusAvailable = typeof platform.getIabUserscriptStatus === "function";
  const manifest = settings?.embeddedBrowserUserscripts;

  const refreshStatus = useCallback(async () => {
    if (!platform.getIabUserscriptStatus) return;
    setStatusLoading(true);
    try {
      const response = await platform.getIabUserscriptStatus();
      setLiveStatus(Array.isArray(response?.scripts) ? response.scripts : []);
    } catch (error) {
      // 查询失败降级为 manifest 派生行（不猜扫描事实），不打断设置页。
      logger.warn("[userscripts-settings] status query failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      setLiveStatus(null);
    } finally {
      setStatusLoading(false);
    }
  }, [platform]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus, manifest]);

  const rows = useMemo(
    () => buildIabUserscriptRows({ liveStatus, manifest }),
    [liveStatus, manifest],
  );

  const patchEntry = useCallback(
    async (scriptId: string, action: "approve" | "disable") => {
      const currentManifest: NonNullable<AppSettings["embeddedBrowserUserscripts"]> =
        settings?.embeddedBrowserUserscripts ?? {};
      const entry = nextManifestEntry(currentManifest[scriptId], action);
      if (!entry) return;
      setPendingScriptIds((current) => new Set(current).add(scriptId));
      try {
        await update({
          embeddedBrowserUserscripts: { ...currentManifest, [scriptId]: entry },
        });
        toast(intl.formatMessage({ id: "settings.userscripts.savedToast" }));
        await refreshStatus();
      } catch (error) {
        logger.error("[userscripts-settings] patch manifest failed", {
          error: error instanceof Error ? error.message : String(error),
          scriptId,
        });
        toast(intl.formatMessage({ id: "settings.userscripts.failedToast" }));
      } finally {
        setPendingScriptIds((current) => {
          const next = new Set(current);
          next.delete(scriptId);
          return next;
        });
      }
    },
    [intl, refreshStatus, settings?.embeddedBrowserUserscripts, update],
  );

  const renderBadges = (badges: IabUserscriptBadgeKind[]) => (
    <span className="flex flex-wrap items-center gap-1.5">
      {badges.map((kind) => (
        <span
          key={kind}
          className={`rounded-md px-2 py-0.5 text-ui-xs font-medium ${
            BADGE_KINDS_WARN.includes(kind) ? WARN_BADGE_CLASS : DEGRADED_BADGE_CLASS
          }`}
        >
          {intl.formatMessage({ id: BADGE_MESSAGE_IDS[kind] })}
        </span>
      ))}
    </span>
  );

  return (
    <SettingsGroupCard>
      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <div className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.userscripts.title" })}
        </div>
        {statusLoading ? (
          <LoaderCircle className="size-4 animate-spin text-foreground-subtle" aria-hidden="true" />
        ) : null}
      </div>
      <div className="px-4 pb-3 text-ui-sm text-muted-foreground">
        {intl.formatMessage({ id: "settings.userscripts.description" })}
      </div>
      {!statusAvailable ? (
        <div className="mx-4 mb-3 flex items-start gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-ui-sm text-foreground-subtle">
          <ShieldQuestion className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {intl.formatMessage({ id: "settings.userscripts.liveUnavailableHint" })}
        </div>
      ) : null}
      {rows.length === 0 ? (
        <div className="px-4 pb-4 text-ui-sm text-muted-foreground">
          {intl.formatMessage({
            id: statusAvailable ? "settings.userscripts.empty" : "settings.userscripts.emptyManifest",
          })}
        </div>
      ) : (
        rows.map((row) => {
          const busy = pendingScriptIds.has(row.scriptId);
          const ariaLabel = intl.formatMessage(
            { id: "settings.userscripts.toggleLabel" },
            { name: row.name },
          );
          return (
            <SettingsRow
              key={row.scriptId}
              label={
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                    <span className="truncate font-medium">{row.name}</span>
                    <span className="shrink-0 font-mono text-ui-xs text-foreground-subtle">
                      {row.scriptId}
                      {row.shaShort ? ` · ${row.shaShort}` : ""}
                    </span>
                  </span>
                  {renderBadges(row.badges)}
                </span>
              }
              control={
                <span className="flex shrink-0 items-center gap-2">
                  {row.showApprove ? (
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy}
                      onClick={() => void patchEntry(row.scriptId, "approve")}
                    >
                      {intl.formatMessage({ id: "settings.userscripts.approve" })}
                    </Button>
                  ) : null}
                  <Switch
                    aria-label={ariaLabel}
                    checked={row.switchChecked}
                    disabled={busy || row.switchDisabled}
                    onCheckedChange={(checked) =>
                      void patchEntry(row.scriptId, checked ? "approve" : "disable")
                    }
                  />
                </span>
              }
            />
          );
        })
      )}
    </SettingsGroupCard>
  );
}
