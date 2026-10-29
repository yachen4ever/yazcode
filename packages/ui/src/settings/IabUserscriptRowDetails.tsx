import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { IabUserscriptEditor } from "@/settings/IabUserscriptEditor.js";
import type { IabUserscriptViewRow } from "@/settings/iabUserscriptsCardPresentation.js";

/**
 * 行展开详情（P4）：元数据 + detail 原文 + 编辑器 + 删除（双确认）。
 * 编辑器初值 = readScript 回读（main 权威内容，不用行上缓存的任何派生）。
 *
 * 删除顺序（spec P4 红线 6，先降权再销毁）：
 * 确认框 1（明示移除启用记录）→ patch manifest 移除条目（该步失败即中止，
 * 不留「文件没了但 manifest 还写着 enabled」的中间态）→ 存在 GM 存储时
 * 确认框 2 独立出现（「删除数据」或「仅删脚本」；取消存储删除 = 仅删脚本）→
 * 调删除通道。确认框 2 出现在删除通道之前：deleteScript 对文件已删的脚本回
 * unknown_script，先删文件再补删存储走不通；两个确认框的文案与语义不变。
 */
export function IabUserscriptRowDetails({
  row,
  onWriteSettled,
  onClose,
}: {
  row: IabUserscriptViewRow;
  onWriteSettled: () => Promise<void>;
  onClose: () => void;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const { settings, update } = useSettings();
  const [content, setContent] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [confirmStorageOpen, setConfirmStorageOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!platform.readIabUserscript) return;
      try {
        const result = await platform.readIabUserscript({ scriptId: row.scriptId });
        if (cancelled) return;
        if (result.ok) {
          setContent(result.content);
        } else {
          setLoadError(
            result.error === "unknown_script"
              ? intl.formatMessage({ id: "settings.userscripts.error.unknown_script" })
              : intl.formatMessage({ id: "settings.userscripts.error.read_failed" }),
          );
        }
      } catch (error) {
        if (cancelled) return;
        logger.warn("[userscripts-settings] read failed", {
          error: error instanceof Error ? error.message : String(error),
          scriptId: row.scriptId,
        });
        setLoadError(intl.formatMessage({ id: "settings.userscripts.error.read_failed" }));
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [intl, platform, row.scriptId]);

  /** patch manifest 移除条目；失败返回 false（删除通道不调用，文件保留）。 */
  const removeManifestEntry = useCallback(async (): Promise<boolean> => {
    const currentManifest = settings?.embeddedBrowserUserscripts ?? {};
    if (!(row.scriptId in currentManifest)) return true;
    const { [row.scriptId]: _removed, ...rest } = currentManifest;
    try {
      await update({ embeddedBrowserUserscripts: rest });
      return true;
    } catch (error) {
      logger.error("[userscripts-settings] delete patch manifest failed", {
        error: error instanceof Error ? error.message : String(error),
        scriptId: row.scriptId,
      });
      toast(intl.formatMessage({ id: "settings.userscripts.delete.patchFailedToast" }));
      return false;
    }
  }, [intl, row.scriptId, settings?.embeddedBrowserUserscripts, update]);

  const deleteScript = useCallback(
    async (deleteStorage: boolean) => {
      if (!platform.deleteIabUserscript) return;
      setBusy(true);
      try {
        const result = await platform.deleteIabUserscript({
          scriptId: row.scriptId,
          deleteStorage,
        });
        if (!result.ok) {
          const mapped =
            result.error === "invalid_script_id"
              ? intl.formatMessage({ id: "settings.userscripts.error.invalid_script_id" })
              : result.error === "unknown_script"
                ? intl.formatMessage({ id: "settings.userscripts.error.unknown_script" })
                : intl.formatMessage({ id: "settings.userscripts.error.delete_failed" });
          toast(mapped);
          return;
        }
        toast(intl.formatMessage({ id: "settings.userscripts.delete.successToast" }));
        onClose();
        await onWriteSettled();
      } catch (error) {
        logger.error("[userscripts-settings] delete failed", {
          error: error instanceof Error ? error.message : String(error),
          scriptId: row.scriptId,
        });
        toast(intl.formatMessage({ id: "settings.userscripts.delete.failedToast" }));
      } finally {
        setBusy(false);
      }
    },
    [intl, onClose, onWriteSettled, platform, row.scriptId],
  );

  /** 确认框 1 通过：先 patch manifest（失败即中止），再按存储有无进入下一段。 */
  async function handleDeleteConfirmed() {
    setBusy(true);
    const patched = await removeManifestEntry();
    setBusy(false);
    setConfirmDeleteOpen(false);
    if (!patched) return;
    if (row.hasStorageFile) {
      setConfirmStorageOpen(true);
    } else {
      await deleteScript(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 border-t border-border bg-surface px-4 py-3">
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-ui-sm text-foreground-subtle">
        <span>
          {intl.formatMessage({ id: "settings.userscripts.details.meta.sha" })}
          {": "}
          <span className="font-mono">{row.shaShort ?? "—"}</span>
        </span>
        {row.matchDomains.length > 0 ? (
          <span className="font-mono break-all">{row.matchDomains.join("  ")}</span>
        ) : null}
      </div>
      {row.detail ? (
        <div className="whitespace-pre-wrap break-all font-mono text-ui-sm text-destructive">
          {row.detail}
        </div>
      ) : null}
      {content !== null ? (
        <IabUserscriptEditor
          mode="edit"
          initialScriptId={row.scriptId}
          initialContent={content}
          takenScriptIds={[]}
          onWriteSettled={onWriteSettled}
          onFinished={onClose}
        />
      ) : loadError ? (
        <div className="text-ui-sm text-foreground-subtle">{loadError}</div>
      ) : (
        <div className="text-ui-sm text-foreground-subtlest">
          {intl.formatMessage({ id: "settings.userscripts.editor.loading" })}
        </div>
      )}
      <div className="flex items-center justify-end">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          disabled={busy}
          onClick={() => setConfirmDeleteOpen(true)}
        >
          {intl.formatMessage({ id: "settings.userscripts.details.delete" })}
        </Button>
      </div>

      <AlertDialog
        open={confirmDeleteOpen}
        onOpenChange={(next) => {
          if (!next && !busy) setConfirmDeleteOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {intl.formatMessage({ id: "settings.userscripts.delete.confirmTitle" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {intl.formatMessage(
                { id: "settings.userscripts.delete.confirmMessage" },
                { id: row.scriptId },
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button" size="sm" disabled={busy}>
              {intl.formatMessage({ id: "settings.userscripts.editor.cancel" })}
            </AlertDialogCancel>
            <AlertDialogAction
              type="button"
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => void handleDeleteConfirmed()}
            >
              {intl.formatMessage({ id: "settings.userscripts.delete.confirm" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={confirmStorageOpen}
        onOpenChange={(next) => {
          if (!next && !busy) setConfirmStorageOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {intl.formatMessage({ id: "settings.userscripts.delete.storageTitle" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {intl.formatMessage({ id: "settings.userscripts.delete.storageMessage" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => void deleteScript(false)}
            >
              {intl.formatMessage({ id: "settings.userscripts.delete.storageKeep" })}
            </AlertDialogCancel>
            <AlertDialogAction
              type="button"
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => void deleteScript(true)}
            >
              {intl.formatMessage({ id: "settings.userscripts.delete.storageConfirm" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
