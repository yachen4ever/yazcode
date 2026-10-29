import { useEffect, useState } from "react";
import type { IabUserscriptFetchSourceResult, IabUserscriptWriteResult } from "@zcode/shared";
import { USER_SCRIPT_MAX_SOURCE_BYTES, USER_SCRIPT_URL_MAX_BYTES } from "@zcode/shared";
import { AlertTriangle, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  deriveScriptIdFromFilename,
  nextManifestEntryAfterSave,
  suggestAlternateScriptId,
} from "@/settings/iabUserscriptsCardPresentation.js";

type FetchError = Extract<IabUserscriptFetchSourceResult, { ok: false }>["error"];
type WriteError = Extract<IabUserscriptWriteResult, { ok: false }>["error"];

interface FetchedSource {
  url: string;
  content: string;
  name: string;
  version: string | null;
  runAt: string;
  grants: string[];
  match: string[];
  parseError: string | null;
}

/**
 * 从 URL 安装的三段式对话框（P4 红线 3）：输入 URL → 拉取（main 守卫，不落盘）→
 * 预览（元数据 + 源码；parseError 红色阻断、禁用安装）→ 安装（写盘 + patch
 * pendingApproval）。任一步取消/失败都不产生文件。
 */
export function IabUserscriptUrlInstallDialog({
  open,
  takenScriptIds,
  onWriteSettled,
  onClose,
}: {
  open: boolean;
  takenScriptIds: readonly string[];
  onWriteSettled: () => Promise<void>;
  onClose: () => void;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const { settings, update } = useSettings();
  const [stage, setStage] = useState<"input" | "preview">("input");
  const [url, setUrl] = useState("");
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [fetched, setFetched] = useState<FetchedSource | null>(null);
  const [scriptId, setScriptId] = useState("");
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  // 每次打开重置为段 1：上一次的拉取结果不跨会话复用（来源内容可能已变化）。
  useEffect(() => {
    if (open) {
      setStage("input");
      setUrl("");
      setFetchError(null);
      setFetched(null);
      setScriptId("");
      setInstallError(null);
      setConflict(false);
    }
  }, [open]);

  function mapFetchError(error: FetchError): string {
    switch (error) {
      case "invalid_url":
        return intl.formatMessage({ id: "settings.userscripts.url.error.invalid_url" });
      case "not_https":
        return intl.formatMessage({ id: "settings.userscripts.url.error.not_https" });
      case "too_large":
        return intl.formatMessage(
          { id: "settings.userscripts.url.error.too_large" },
          { limit: Math.floor(USER_SCRIPT_URL_MAX_BYTES / 1024 / 1024) },
        );
      case "timeout":
        return intl.formatMessage({ id: "settings.userscripts.url.error.timeout" });
      case "remote_address_not_allowed":
        return intl.formatMessage({
          id: "settings.userscripts.url.error.remote_address_not_allowed",
        });
      default:
        return intl.formatMessage({ id: "settings.userscripts.url.error.download_failed" });
    }
  }

  function mapWriteError(error: WriteError): string {
    switch (error) {
      case "invalid_script_id":
        return intl.formatMessage({ id: "settings.userscripts.error.invalid_script_id" });
      case "invalid_content":
        return intl.formatMessage({ id: "settings.userscripts.error.invalid_content" });
      case "too_large":
        return intl.formatMessage(
          { id: "settings.userscripts.error.too_large" },
          { limit: Math.floor(USER_SCRIPT_MAX_SOURCE_BYTES / 1024 / 1024) },
        );
      case "exists":
        return intl.formatMessage({ id: "settings.userscripts.error.exists" });
      default:
        return intl.formatMessage({ id: "settings.userscripts.error.write_failed" });
    }
  }

  async function handleFetch() {
    if (!platform.fetchIabUserscriptSource) return;
    const trimmed = url.trim();
    if (!trimmed) {
      setFetchError(intl.formatMessage({ id: "settings.userscripts.url.urlRequired" }));
      return;
    }
    setFetching(true);
    setFetchError(null);
    try {
      const result = await platform.fetchIabUserscriptSource({ url: trimmed });
      if (!result.ok) {
        setFetchError(mapFetchError(result.error));
        return;
      }
      setFetched({
        url: result.source.url,
        content: result.source.content,
        name: result.preview.name,
        version: result.preview.version ?? null,
        runAt: result.preview.runAt,
        grants: result.preview.grants,
        match: result.preview.match,
        parseError: result.preview.parseError ?? null,
      });
      // scriptId 预填：最终 URL 的文件名 stem（用户可改；合法性由 main 权威校验）。
      let stem: string | null = null;
      try {
        stem = deriveScriptIdFromFilename(new URL(result.source.url).pathname.split("/").pop() ?? "");
      } catch {
        stem = null;
      }
      setScriptId(stem ?? "");
      setStage("preview");
    } catch (error) {
      logger.warn("[userscripts-settings] fetch source failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      setFetchError(
        intl.formatMessage({ id: "settings.userscripts.url.error.download_failed" }),
      );
    } finally {
      setFetching(false);
    }
  }

  async function installWith(overwrite: boolean) {
    if (!platform.writeIabUserscript || !fetched) return;
    const targetId = scriptId.trim();
    if (!targetId) {
      setInstallError(
        intl.formatMessage({ id: "settings.userscripts.editor.scriptIdRequired" }),
      );
      return;
    }
    setInstalling(true);
    setInstallError(null);
    setConflict(false);
    try {
      const result = await platform.writeIabUserscript({
        scriptId: targetId,
        content: fetched.content,
        overwrite,
      });
      if (!result.ok) {
        if (result.error === "exists") {
          setConflict(true);
          return;
        }
        setInstallError(mapWriteError(result.error));
        return;
      }
      // 安装 = 写盘 + patch manifest（红线 1/2）：按已锚定与否落 pendingApproval
      // 或不写（覆盖已批准脚本 → hash_mismatch）。
      const nextEntry = nextManifestEntryAfterSave(
        settings?.embeddedBrowserUserscripts?.[targetId],
      );
      if (nextEntry) {
        try {
          await update({
            embeddedBrowserUserscripts: {
              ...settings?.embeddedBrowserUserscripts,
              [targetId]: nextEntry,
            },
          });
        } catch (error) {
          logger.error("[userscripts-settings] install patch manifest failed", {
            error: error instanceof Error ? error.message : String(error),
            scriptId: targetId,
          });
        }
      }
      toast(intl.formatMessage({ id: "settings.userscripts.write.successToast" }));
      onClose();
      await onWriteSettled();
    } catch (error) {
      logger.error("[userscripts-settings] install failed", {
        error: error instanceof Error ? error.message : String(error),
        scriptId: targetId,
      });
      toast(intl.formatMessage({ id: "settings.userscripts.write.failedToast" }));
    } finally {
      setInstalling(false);
    }
  }

  function installAsAlternate() {
    const candidate = suggestAlternateScriptId(scriptId.trim(), takenScriptIds);
    if (candidate) setScriptId(candidate);
    setConflict(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !fetching && !installing) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({ id: "settings.userscripts.url.title" })}
          </DialogTitle>
          <DialogDescription>
            {stage === "input"
              ? intl.formatMessage({ id: "settings.userscripts.url.inputHint" })
              : intl.formatMessage({ id: "settings.userscripts.url.previewHint" })}
          </DialogDescription>
        </DialogHeader>

        {stage === "input" ? (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-ui-sm font-medium text-foreground">
                {intl.formatMessage({ id: "settings.userscripts.url.inputLabel" })}
              </span>
              <Input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://example.com/script.user.js"
                className="font-mono"
                spellCheck={false}
              />
            </label>
            {fetchError ? (
              <div className="text-ui-sm text-destructive" role="alert">
                {fetchError}
              </div>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={fetching}
                onClick={onClose}
              >
                {intl.formatMessage({ id: "settings.userscripts.editor.cancel" })}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={fetching}
                onClick={() => void handleFetch()}
              >
                {fetching ? (
                  <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
                ) : null}
                {intl.formatMessage({ id: "settings.userscripts.url.fetch" })}
              </Button>
            </DialogFooter>
          </div>
        ) : fetched ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1 rounded-lg border border-border bg-surface px-3 py-2 text-ui-sm">
              <span className="font-medium text-foreground">{fetched.name}</span>
              {fetched.version ? (
                <span className="font-mono text-ui-xs text-foreground-subtle">
                  v{fetched.version}
                </span>
              ) : null}
              <span className="text-ui-xs text-foreground-subtle">
                run-at: <span className="font-mono">{fetched.runAt}</span>
              </span>
              <span className="text-ui-xs break-all text-foreground-subtle">
                grant: <span className="font-mono">{fetched.grants.join(", ") || "none"}</span>
              </span>
              <span className="text-ui-xs break-all text-foreground-subtle">
                @match: <span className="font-mono">{fetched.match.join(", ") || "—"}</span>
              </span>
              <span className="text-ui-xs truncate text-foreground-subtlest">
                <span className="font-mono">{fetched.url}</span>
              </span>
            </div>
            {fetched.parseError ? (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-ui-sm text-foreground">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
                <span className="min-w-0 break-all">
                  {intl.formatMessage({ id: "settings.userscripts.url.parseErrorBanner" })}
                  <span className="font-mono">{fetched.parseError}</span>
                </span>
              </div>
            ) : null}
            <label className="flex flex-col gap-1">
              <span className="text-ui-sm font-medium text-foreground">
                {intl.formatMessage({ id: "settings.userscripts.editor.scriptIdLabel" })}
              </span>
              <Input
                value={scriptId}
                onChange={(event) => setScriptId(event.target.value)}
                className="font-mono"
                spellCheck={false}
              />
              <span className="text-ui-xs text-foreground-subtlest">
                {intl.formatMessage({ id: "settings.userscripts.editor.scriptIdHint" })}
              </span>
            </label>
            <div className="flex flex-col gap-1">
              <span className="text-ui-sm font-medium text-foreground">
                {intl.formatMessage({ id: "settings.userscripts.url.sourcePreview" })}
              </span>
              <pre className="max-h-56 overflow-auto rounded-lg border border-border bg-background px-3 py-2 font-mono text-ui-xs text-foreground-subtle">
                {fetched.content}
              </pre>
            </div>
            {conflict ? (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-ui-sm text-foreground">
                <AlertTriangle className="size-4 shrink-0 text-warning" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  {intl.formatMessage(
                    { id: "settings.userscripts.editor.existsHint" },
                    { id: scriptId.trim() },
                  )}
                </span>
                <Button type="button" variant="outline" size="sm" disabled={installing} onClick={installAsAlternate}>
                  {intl.formatMessage({ id: "settings.userscripts.editor.saveAsAlternate" })}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={installing}
                  onClick={() => void installWith(true)}
                >
                  {intl.formatMessage({ id: "settings.userscripts.editor.overwrite" })}
                </Button>
              </div>
            ) : null}
            {installError ? (
              <div className="text-ui-sm text-destructive" role="alert">
                {installError}
              </div>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={installing}
                onClick={() => setStage("input")}
              >
                {intl.formatMessage({ id: "settings.userscripts.url.back" })}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={installing || fetched.parseError !== null}
                onClick={() => void installWith(false)}
              >
                {intl.formatMessage({ id: "settings.userscripts.url.install" })}
              </Button>
            </DialogFooter>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
