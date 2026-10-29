import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";
import {
  badgeTone,
  type IabUserscriptBadgeKind,
  type IabUserscriptBadgeTone,
  type IabUserscriptViewRow,
} from "@/settings/iabUserscriptsCardPresentation.js";

/**
 * 单行呈现（P3 建立、P4 加行展开）：只依赖投影层与 SettingsPageParts，不持有状态。
 * 颜色即语义：success/warning/destructive 只用于对应的状态，neutral 只用于
 * 「无活动状态」的 enabled/disabled（DESIGN.md 语义色约束，投影层给出映射）。
 * 行体可点开展开详情/编辑器（P4：桌面宿主下由卡片传入展开态；降级模式传 false）。
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

const BADGE_TONE_CLASS: Record<IabUserscriptBadgeTone, string> = {
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  destructive: "bg-destructive/10 text-destructive",
  neutral: "bg-surface text-foreground-subtle",
};

export interface IabUserscriptsSettingsRowProps {
  row: IabUserscriptViewRow;
  busy: boolean;
  onApprove: () => void;
  onReapprove: () => void;
  onToggle: (checked: boolean) => void;
  /** P4 行展开：undefined = 不可展开（无宿主降级）；给出时行体可点击。 */
  expanded?: boolean;
  onToggleExpand?: () => void;
}

export function IabUserscriptsSettingsRow({
  row,
  busy,
  onApprove,
  onReapprove,
  onToggle,
  expanded,
  onToggleExpand,
}: IabUserscriptsSettingsRowProps) {
  const { intl, locale } = useZCodeIntl();
  const ariaLabel = intl.formatMessage(
    { id: "settings.userscripts.toggleLabel" },
    { name: row.name },
  );
  const lastInjectedLabel =
    row.lastInjectedAt === null
      ? intl.formatMessage({ id: "settings.userscripts.neverInjected" })
      : intl.formatMessage(
          { id: "settings.userscripts.lastInjected" },
          // 时间格式跟随应用语言（fa-IR 的日期形态与 en/zh 不同），不落系统默认。
          { time: new Date(row.lastInjectedAt).toLocaleString(locale) },
        );

  const expandable = onToggleExpand !== undefined;
  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <SettingsRow
      label={
        expandable ? (
          <button
            type="button"
            className="flex min-w-0 flex-1 cursor-pointer flex-col gap-1.5 text-start"
            onClick={onToggleExpand}
            aria-expanded={expanded}
          >
            <span className="flex items-start gap-1">
              <Chevron className="mt-0.5 size-4 shrink-0 text-foreground-subtlest" aria-hidden="true" />
              <RowTitle row={row} />
            </span>
            <RowMeta row={row} lastInjectedLabel={lastInjectedLabel} />
          </button>
        ) : (
          <span className="flex min-w-0 flex-col gap-1.5">
            <RowTitle row={row} />
            <RowMeta row={row} lastInjectedLabel={lastInjectedLabel} />
          </span>
        )
      }
      detail={
        row.detail ? (
          <div className="whitespace-pre-wrap break-all font-mono text-ui-sm text-foreground-subtle">
            {row.detail}
          </div>
        ) : undefined
      }
      control={
        <span className="flex shrink-0 items-center gap-2">
          {row.showApprove ? (
            <Button type="button" size="sm" disabled={busy} onClick={onApprove}>
              {intl.formatMessage({ id: "settings.userscripts.approve" })}
            </Button>
          ) : null}
          {row.showReapprove ? (
            <Button type="button" size="sm" disabled={busy} onClick={onReapprove}>
              {intl.formatMessage({ id: "settings.userscripts.reapprove" })}
            </Button>
          ) : null}
          <Switch
            aria-label={ariaLabel}
            checked={row.switchChecked}
            disabled={busy || row.switchDisabled}
            onCheckedChange={onToggle}
          />
        </span>
      }
    />
  );
}

function RowTitle({ row }: { row: IabUserscriptViewRow }) {
  const { intl } = useZCodeIntl();
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className="min-w-0 truncate font-medium">{row.name}</span>
      {row.version ? (
        <span className="shrink-0 font-mono text-ui-xs text-foreground-subtle">v{row.version}</span>
      ) : null}
      <span className="flex flex-wrap items-center gap-1.5">
        {row.badges.map((kind) => (
          <span
            key={kind}
            className={`rounded-md px-2 py-0.5 text-ui-xs font-medium ${BADGE_TONE_CLASS[badgeTone(kind)]}`}
          >
            {intl.formatMessage({ id: BADGE_MESSAGE_IDS[kind] })}
          </span>
        ))}
      </span>
    </span>
  );
}

function RowMeta({ row, lastInjectedLabel }: { row: IabUserscriptViewRow; lastInjectedLabel: string }) {
  return (
    <>
      {/* @match 域名：允许换行，多条 pattern 是并列关系而非一条长串。 */}
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-ui-xs text-foreground-subtle">
        <span className="truncate">{row.scriptId}</span>
        {row.matchDomains.length > 0
          ? row.matchDomains.map((domain) => (
              <span key={domain} className="break-all">
                {domain}
              </span>
            ))
          : null}
      </span>
      <span className="text-ui-xs text-foreground-subtlest">{lastInjectedLabel}</span>
    </>
  );
}
