import { useCallback, useEffect, useMemo, useState } from "react";
import { LoaderCircle, ShieldQuestion } from "lucide-react";
import type { AppSettings, IabUserscriptStatusItem } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { IabUserscriptsSettingsRow } from "@/settings/IabUserscriptsSettingsRow.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";
import {
  buildIabUserscriptRows,
  nextManifestEntry,
  partitionIabUserscriptRows,
  type IabUserscriptViewRow,
} from "@/settings/iabUserscriptsCardPresentation.js";

/**
 * IAB 用户脚本设置卡（P2 建立、P3 列表化；契约见 docs/specs/iab-userscripts.md）：
 * - 开关/批准动作只经 useSettings() 的 SettingService patch（manifest 唯一写路径），
 *   开 = 用户批准（钉住所见 sha256），关 = 禁用或驳回待批准；
 * - 实时状态（name/match/当前 hash/损坏态/最近注入）来自可选平台方法
 *   getIabUserscriptStatus（只读投影）；无宿主环境（普通 Web）降级为 manifest 派生行，
 *   不猜测扫描事实；
 * - 待批准行单独置顶成组：分区由投影层纯函数给出，底层仍是同一份状态列表。
 * 设置卡刻意不走 browser 命令面：agent 的 set_enabled 由 main 按「命令面即 agent
 * 来源」识别，复用会让用户点击被当成 agent 请求而永远停在 pending_approval。
 */

function SectionHeading({ children }: { children: string }) {
  // 标题只在「该分区有行」时渲染，因此恒为上边框 + 行组的起始分隔。
  return (
    <div className="border-t border-border px-4 pb-1 pt-3 text-ui-sm font-medium text-foreground-subtle">
      {children}
    </div>
  );
}

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
  const partition = useMemo(() => partitionIabUserscriptRows(rows), [rows]);

  const patchEntry = useCallback(
    async (scriptId: string, action: "approve" | "disable") => {
      const currentManifest: NonNullable<AppSettings["embeddedBrowserUserscripts"]> =
        settings?.embeddedBrowserUserscripts ?? {};
      // M1（P2 复核）：批准钉住用户所见 sha，其后内容变更落 hash_mismatch 而非被静默锚定。
      // hash_mismatch 的「重新批准」复用同一动作：所见 sha 即当前文件 hash。
      const seenSha256 = rows.find((row) => row.scriptId === scriptId)?.sha256 ?? null;
      const entry = nextManifestEntry(currentManifest[scriptId], action, seenSha256);
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
    [intl, refreshStatus, rows, settings?.embeddedBrowserUserscripts, update],
  );

  const renderRow = (row: IabUserscriptViewRow) => (
    <IabUserscriptsSettingsRow
      key={row.scriptId}
      row={row}
      busy={pendingScriptIds.has(row.scriptId)}
      onApprove={() => void patchEntry(row.scriptId, "approve")}
      onReapprove={() => void patchEntry(row.scriptId, "approve")}
      onToggle={(checked) => void patchEntry(row.scriptId, checked ? "approve" : "disable")}
    />
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
            id: statusAvailable
              ? "settings.userscripts.empty"
              : "settings.userscripts.emptyManifest",
          })}
        </div>
      ) : (
        <>
          {partition.pending.length > 0 ? (
            <>
              <SectionHeading>
                {intl.formatMessage({ id: "settings.userscripts.pendingSection" })}
              </SectionHeading>
              {partition.pending.map(renderRow)}
            </>
          ) : null}
          {partition.others.length > 0 ? (
            <>
              {partition.pending.length > 0 ? (
                <SectionHeading>
                  {intl.formatMessage({ id: "settings.userscripts.othersSection" })}
                </SectionHeading>
              ) : null}
              {partition.others.map(renderRow)}
            </>
          ) : null}
        </>
      )}
    </SettingsGroupCard>
  );
}
