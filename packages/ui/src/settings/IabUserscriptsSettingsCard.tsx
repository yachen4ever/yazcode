import { useCallback, useEffect, useMemo, useState, Fragment } from "react";
import { LoaderCircle, ShieldQuestion } from "lucide-react";
import type { AppSettings, IabUserscriptStatusItem } from "@zcode/shared";
import { USER_SCRIPT_MAX_SOURCE_BYTES } from "@zcode/shared";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { IabUserscriptToolsRow } from "@/settings/IabUserscriptToolsRow.js";
import { IabUserscriptUrlInstallDialog } from "@/settings/IabUserscriptUrlInstallDialog.js";
import { IabUserscriptEditor } from "@/settings/IabUserscriptEditor.js";
import { IabUserscriptRowDetails } from "@/settings/IabUserscriptRowDetails.js";
import { IabUserscriptsSettingsRow } from "@/settings/IabUserscriptsSettingsRow.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";
import {
  buildIabUserscriptRows,
  buildNewScriptTemplate,
  deriveScriptIdFromFilename,
  nextManifestEntry,
  partitionIabUserscriptRows,
  type IabUserscriptViewRow,
} from "@/settings/iabUserscriptsCardPresentation.js";

/**
 * IAB 用户脚本设置卡（P2 建立、P3 列表化、P4 自助管理；契约见 docs/specs/iab-userscripts.md）：
 * - 开关/批准动作只经 useSettings() 的 SettingService patch（manifest 唯一写路径），
 *   开 = 用户批准（钉住所见 sha256），关 = 禁用或驳回待批准；
 * - 实时状态（name/match/当前 hash/损坏态/最近注入）来自可选平台方法
 *   getIabUserscriptStatus（只读投影）；无宿主环境（普通 Web）降级为 manifest 派生行；
 * - P4 工具行（新建/导入/从 URL 安装）与行展开编辑器只在 statusAvailable 时渲染；
 *   写盘通道不写 sha256（落盘 ≠ 批准），批准仍只经批准按钮。
 */

/** P4 编辑会话：create（新建/导入，内容已就绪）或 edit（行展开内联，面板自管内容）。 */
type EditorSession = { kind: "create"; scriptId: string; content: string } | { kind: "edit" };

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
  const [editor, setEditor] = useState<EditorSession | null>(null);
  const [urlDialogOpen, setUrlDialogOpen] = useState(false);
  const [expandedScriptId, setExpandedScriptId] = useState<string | null>(null);

  const statusAvailable = typeof platform.getIabUserscriptStatus === "function";
  const hostFileAvailable =
    statusAvailable &&
    typeof platform.writeIabUserscript === "function" &&
    typeof platform.readIabUserscript === "function" &&
    typeof platform.deleteIabUserscript === "function" &&
    typeof platform.fetchIabUserscriptSource === "function";
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
  const takenScriptIds = useMemo(() => rows.map((row) => row.scriptId), [rows]);

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

  /** 新建：以本地化模板为初始内容，scriptId 由用户在编辑器中输入。 */
  const handleCreate = useCallback(() => {
    setEditor({
      kind: "create",
      scriptId: "",
      content: buildNewScriptTemplate({
        name: intl.formatMessage({ id: "settings.userscripts.template.name" }),
        matchHint: intl.formatMessage({ id: "settings.userscripts.hints.matchHost" }),
        frameHint: intl.formatMessage({ id: "settings.userscripts.hints.frame" }),
      }),
    });
  }, [intl]);

  /** 导入：渲染进程 file.text() 读内容（不扩 main 的任意路径读面），scriptId 取文件名 stem。 */
  const handleImportFile = useCallback(
    (file: File) => {
      void (async () => {
        if (file.size > USER_SCRIPT_MAX_SOURCE_BYTES) {
          toast(
            intl.formatMessage(
              { id: "settings.userscripts.error.too_large" },
              { limit: Math.floor(USER_SCRIPT_MAX_SOURCE_BYTES / 1024 / 1024) },
            ),
          );
          return;
        }
        const scriptId = deriveScriptIdFromFilename(file.name);
        if (!scriptId) {
          toast(intl.formatMessage({ id: "settings.userscripts.importInvalidName" }));
          return;
        }
        try {
          const content = await file.text();
          setEditor({ kind: "create", scriptId, content });
        } catch (error) {
          logger.warn("[userscripts-settings] import read failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          toast(intl.formatMessage({ id: "settings.userscripts.importReadFailed" }));
        }
      })();
    },
    [intl],
  );

  const closeEditor = useCallback(() => setEditor(null), []);

  const renderRow = (row: IabUserscriptViewRow) => (
    <Fragment key={row.scriptId}>
      <IabUserscriptsSettingsRow
        row={row}
        busy={pendingScriptIds.has(row.scriptId)}
        onApprove={() => void patchEntry(row.scriptId, "approve")}
        onReapprove={() => void patchEntry(row.scriptId, "approve")}
        onToggle={(checked) => void patchEntry(row.scriptId, checked ? "approve" : "disable")}
        expanded={hostFileAvailable && expandedScriptId === row.scriptId ? true : undefined}
        onToggleExpand={
          hostFileAvailable
            ? () =>
                setExpandedScriptId((current) =>
                  current === row.scriptId ? null : row.scriptId,
                )
            : undefined
        }
      />
      {hostFileAvailable && expandedScriptId === row.scriptId ? (
        <IabUserscriptRowDetails
          row={row}
          onWriteSettled={refreshStatus}
          onClose={() => setExpandedScriptId(null)}
        />
      ) : null}
    </Fragment>
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
      {hostFileAvailable ? (
        <IabUserscriptToolsRow
          onCreate={handleCreate}
          onImportFile={handleImportFile}
          onInstallFromUrl={() => setUrlDialogOpen(true)}
        />
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
      <Dialog
        open={editor?.kind === "create"}
        onOpenChange={(next) => {
          if (!next) closeEditor();
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {intl.formatMessage({ id: "settings.userscripts.createTitle" })}
            </DialogTitle>
            <DialogDescription>
              {intl.formatMessage({ id: "settings.userscripts.createHint" })}
            </DialogDescription>
          </DialogHeader>
          {editor?.kind === "create" ? (
            <IabUserscriptEditor
              mode="create"
              initialScriptId={editor.scriptId}
              initialContent={editor.content}
              takenScriptIds={takenScriptIds}
              onWriteSettled={refreshStatus}
              onFinished={closeEditor}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <IabUserscriptUrlInstallDialog
        open={urlDialogOpen}
        takenScriptIds={takenScriptIds}
        onWriteSettled={refreshStatus}
        onClose={() => setUrlDialogOpen(false)}
      />
    </SettingsGroupCard>
  );
}
