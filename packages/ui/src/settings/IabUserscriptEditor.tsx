import { useState } from "react";
import type { IabUserscriptWriteResult } from "@zcode/shared";
import { USER_SCRIPT_MAX_SOURCE_BYTES } from "@zcode/shared";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  nextManifestEntryAfterSave,
  suggestAlternateScriptId,
} from "@/settings/iabUserscriptsCardPresentation.js";

type WriteError = Extract<IabUserscriptWriteResult, { ok: false }>["error"];

/**
 * P4 脚本编辑器（新建 / 导入 / 行展开编辑共用同一组件）：
 * - create 模式：scriptId 可输入，先以 overwrite:false 写，exists 时给「覆盖 / 另存」；
 * - edit 模式：scriptId 固定，overwrite:true（目标文件本就存在，覆盖即编辑语义）。
 *
 * 保存语义（spec P4 红线 1/2，承重）：写盘通道本身不写 manifest——落盘 ≠ 批准；
 * 成功后按 nextManifestEntryAfterSave 决定是否 patch：已锚定条目不 patch
 * （扫描自然落 hash_mismatch），其余 patch {enabled:false, pendingApproval:true}。
 * 任何路径都不写 {enabled:true, sha256} 组合，那是批准按钮的专属语义。
 */
export function IabUserscriptEditor({
  mode,
  initialScriptId,
  initialContent,
  takenScriptIds,
  onWriteSettled,
  onFinished,
}: {
  mode: "create" | "edit";
  initialScriptId: string;
  initialContent: string;
  /** 已占用的 scriptId 集合，「另存」候选用它避开现存脚本。 */
  takenScriptIds: readonly string[];
  /** 写盘/patch 结束后的状态刷新（设置卡的 refreshStatus）。 */
  onWriteSettled: () => Promise<void>;
  /** 保存成功或取消后关闭宿主（对话框 / 展开面板）。 */
  onFinished: () => void;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const { settings, update } = useSettings();
  const [scriptId, setScriptId] = useState(initialScriptId);
  const [content, setContent] = useState(initialContent);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

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

  async function saveWith(overwrite: boolean) {
    if (!platform.writeIabUserscript) return;
    const targetId = scriptId.trim();
    if (!targetId) {
      setErrorText(intl.formatMessage({ id: "settings.userscripts.editor.scriptIdRequired" }));
      return;
    }
    setSaving(true);
    setErrorText(null);
    setConflict(false);
    try {
      const result = await platform.writeIabUserscript({
        scriptId: targetId,
        content,
        overwrite,
      });
      if (!result.ok) {
        if (result.error === "exists") {
          // 重名必须显式覆盖（红线 5）：给出「覆盖 / 另存」，目标文件未被动过。
          setConflict(true);
          return;
        }
        const mapped = mapWriteError(result.error);
        setErrorText(mapped);
        toast(intl.formatMessage({ id: "settings.userscripts.write.failedToast" }));
        return;
      }

      // 写盘成功 → patch manifest（红线 1）。已锚定条目返回 null：不写 manifest，
      // 扫描自然落 hash_mismatch；patch 失败不打回写盘结果（文件已在，条目缺席
      // 时 fail-closed 不服务），仅提示失败并刷新状态。
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
          logger.error("[userscripts-settings] save patch manifest failed", {
            error: error instanceof Error ? error.message : String(error),
            scriptId: targetId,
          });
        }
      }
      toast(intl.formatMessage({ id: "settings.userscripts.write.successToast" }));
      await onWriteSettled();
      onFinished();
    } catch (error) {
      logger.error("[userscripts-settings] write failed", {
        error: error instanceof Error ? error.message : String(error),
        scriptId: targetId,
      });
      toast(intl.formatMessage({ id: "settings.userscripts.write.failedToast" }));
    } finally {
      setSaving(false);
    }
  }

  function saveAsAlternate() {
    // 「另存」：自动给出首个未占用候选，用户可继续修改；合法性由 main 权威校验。
    const base = scriptId.trim();
    const candidate = suggestAlternateScriptId(base, takenScriptIds);
    if (candidate) setScriptId(candidate);
    setConflict(false);
  }

  return (
    <div className="flex flex-col gap-3">
      {mode === "create" ? (
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
      ) : (
        <div className="text-ui-xs text-foreground-subtlest">
          <span className="font-mono">{scriptId}</span>
          {" · "}
          <span className="font-mono">{scriptId}.user.js</span>
        </div>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-ui-sm font-medium text-foreground">
          {intl.formatMessage({ id: "settings.userscripts.editor.contentLabel" })}
        </span>
        <Textarea
          value={content}
          onChange={(event) => setContent(event.target.value)}
          className="max-h-[60vh] min-h-64 overflow-y-auto font-mono text-ui-sm"
          spellCheck={false}
        />
        <span className="text-ui-xs text-foreground-subtlest">
          {intl.formatMessage(
            { id: "settings.userscripts.editor.maxSizeHint" },
            { limit: Math.floor(USER_SCRIPT_MAX_SOURCE_BYTES / 1024 / 1024) },
          )}
        </span>
        <span className="text-ui-xs text-foreground-subtlest">
          {intl.formatMessage({ id: "settings.userscripts.hints.matchHost" })}
        </span>
        <span className="text-ui-xs text-foreground-subtlest">
          {intl.formatMessage({ id: "settings.userscripts.hints.frame" })}
        </span>
      </label>
      {conflict ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-ui-sm text-foreground">
          <AlertTriangle className="size-4 shrink-0 text-warning" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            {intl.formatMessage(
              { id: "settings.userscripts.editor.existsHint" },
              { id: scriptId.trim() },
            )}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={saveAsAlternate}
          >
            {intl.formatMessage({ id: "settings.userscripts.editor.saveAsAlternate" })}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={saving}
            onClick={() => void saveWith(true)}
          >
            {intl.formatMessage({ id: "settings.userscripts.editor.overwrite" })}
          </Button>
        </div>
      ) : null}
      {errorText ? (
        <div className="text-ui-sm text-destructive" role="alert">
          {errorText}
        </div>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={onFinished}>
          {intl.formatMessage({ id: "settings.userscripts.editor.cancel" })}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={saving}
          onClick={() => void saveWith(mode === "edit")}
        >
          {intl.formatMessage({ id: "settings.userscripts.editor.save" })}
        </Button>
      </div>
    </div>
  );
}
