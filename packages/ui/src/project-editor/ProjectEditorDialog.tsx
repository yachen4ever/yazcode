import { useCallback, useEffect, useRef, useState } from "react";
import { Folder, FolderPlus, LoaderCircle, X } from "lucide-react";
import type { ProjectRecord } from "@zcode/services";
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
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { useProjectStore } from "@/store/projectStore.js";
import { leafNameOf, projectDisplayName } from "@/lib/projectPresentation.js";
import {
  addRootsToForm,
  buildProjectSaveInput,
  createProjectEditorForm,
  projectEditorDisplayName,
  projectEditorErrorKey,
  removeRootFromForm,
  renameProjectInForm,
  setPrimaryRootInForm,
  type ProjectEditorForm,
} from "@/project-editor/projectEditorModel.js";

/**
 * 项目编辑器（docs/specs/multi-root-projects.md「P3b 项目编辑器」）。
 *
 * 状态所有者：表单态是本组件局部 state；提交成功后以 IProjectService 返回的
 * ProjectRecord 就地更新 projectStore（读模型），不重放写路径。目录选择走
 * IPlatformService.selectDirectory() 单选 + 继续添加（平台面当前无系统多选）。
 *
 * 迟到防护：保存/删除/目录选择的异步回执以 epoch/alive 失效——卸载或换代
 * （epoch 递增）后到达的回执一律丢弃，不用超时掩盖竞态（ZCodium 同型，按本仓重做）。
 */
export function ProjectEditorDialog({
  project,
  onClose,
}: {
  /** null = 新建。 */
  project: ProjectRecord | null;
  onClose: () => void;
}) {
  const { intl } = useZCodeIntl();
  const { projectService } = useServices();
  const platform = usePlatform();
  const confirm = useConfirmDialog();
  const upsertProject = useProjectStore((state) => state.upsert);
  const removeProject = useProjectStore((state) => state.remove);
  const [form, setForm] = useState<ProjectEditorForm>(() => createProjectEditorForm(project));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const epochRef = useRef(0);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      epochRef.current += 1;
    };
  }, []);
  const current = useCallback(
    (request: number) => aliveRef.current && epochRef.current === request,
    [],
  );
  const msg = useCallback(
    (id: string, values?: Record<string, string>) => intl.formatMessage({ id }, values),
    [intl],
  );

  const browse = useCallback(async () => {
    const request = ++epochRef.current;
    setError(null);
    let selected: string | null = null;
    try {
      selected = await platform.selectDirectory();
    } catch (cause) {
      logger.warn("[project-editor] 目录选择失败", cause);
      if (current(request)) setError(msg(projectEditorErrorKey(cause)));
      return;
    }
    if (!current(request)) return;
    if (selected) {
      setForm((currentForm) => addRootsToForm(currentForm, [selected]));
    }
  }, [current, msg, platform]);

  const save = useCallback(async () => {
    const request = epochRef.current;
    const input = buildProjectSaveInput(form, { projectId: project?.projectId });
    if (!input) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await projectService.saveProject(input);
      if (!current(request)) return;
      upsertProject(saved);
      logger.info("[project-editor] 项目已保存", {
        projectId: saved.projectId,
        rootCount: saved.roots.length,
      });
      onClose();
    } catch (cause) {
      logger.warn("[project-editor] 项目保存失败", cause);
      if (current(request)) setError(msg(projectEditorErrorKey(cause)));
    } finally {
      if (current(request)) setBusy(false);
    }
  }, [current, form, msg, onClose, project, projectService, upsertProject]);

  const remove = useCallback(async () => {
    if (!project) return;
    const request = ++epochRef.current;
    const accepted = await confirm({
      title: msg("projectEditor.deleteTitle"),
      description: msg("projectEditor.deleteDescription", {
        name: projectDisplayName(project),
      }),
    });
    if (!accepted) {
      if (current(request)) setBusy(false);
      return;
    }
    if (!current(request)) return;
    setBusy(true);
    setError(null);
    try {
      await projectService.deleteProject(project.projectId);
      if (!current(request)) return;
      removeProject(project.projectId);
      logger.info("[project-editor] 项目已删除", { projectId: project.projectId });
      onClose();
    } catch (cause) {
      logger.warn("[project-editor] 项目删除失败", cause);
      if (current(request)) setError(msg(projectEditorErrorKey(cause)));
    } finally {
      if (current(request)) setBusy(false);
    }
  }, [confirm, current, msg, onClose, project, projectService, removeProject]);

  const rootsEmpty = form.roots.length === 0;
  const title = project ? msg("projectEditor.editTitle") : msg("projectEditor.createTitle");

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-w-lg overflow-hidden rounded-2xl p-0">
        <div className="flex min-w-0 flex-col gap-5 p-6">
          <DialogHeader className="space-y-2">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className="sr-only">
              {msg("projectEditor.description")}
            </DialogDescription>
          </DialogHeader>
          <div className="grid min-w-0 gap-1.5">
            <label htmlFor="project-editor-name" className="text-ui-sm font-medium text-foreground">
              {msg("projectEditor.name")}
            </label>
            <Input
              id="project-editor-name"
              value={form.name}
              size="lg"
              disabled={busy}
              placeholder={projectEditorDisplayNamePlaceholder(form)}
              onChange={(event) => {
                setForm((currentForm) => renameProjectInForm(currentForm, event.target.value));
              }}
              className="max-md:text-mobile-input-safe"
            />
          </div>
          <fieldset disabled={busy} className="min-w-0">
            <legend className="mb-1.5 text-ui-sm font-medium text-foreground">
              {msg("projectEditor.folders")}
            </legend>
            {rootsEmpty ? null : (
              <div className="min-w-0 divide-y divide-border overflow-hidden rounded-xl border border-border">
                {form.roots.map((root) => (
                  <div
                    key={root}
                    data-testid="project-editor-root-row"
                    className="flex min-h-12 min-w-0 items-center gap-2 px-3 py-2"
                  >
                    <Folder className="size-4 shrink-0 text-foreground-subtle" />
                    <span
                      className="min-w-0 flex-1 truncate text-ui-base"
                      title={root}
                      data-testid="project-editor-root-name"
                    >
                      {leafNameOf(root)}
                    </span>
                    {root === form.primaryRoot ? (
                      <span
                        data-testid="project-editor-primary-badge"
                        className="inline-flex h-7 shrink-0 items-center rounded-md border border-border px-2 text-ui-base text-foreground-subtle"
                      >
                        {msg("projectEditor.primaryBadge")}
                      </span>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-foreground-subtle"
                        data-testid="project-editor-set-primary"
                        onClick={() => {
                          setForm((currentForm) => setPrimaryRootInForm(currentForm, root));
                        }}
                      >
                        {msg("projectEditor.setPrimary")}
                      </Button>
                    )}
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="text-foreground-subtle"
                      aria-label={msg("projectEditor.removeFolder")}
                      data-testid="project-editor-remove-folder"
                      onClick={() => {
                        setForm((currentForm) => removeRootFromForm(currentForm, root));
                      }}
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <button
              type="button"
              data-testid="project-editor-browse"
              className={`group flex w-full items-center gap-2 text-ui-base transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30 ${
                rootsEmpty
                  ? "mt-2 min-h-32 flex-col justify-center rounded-xl border border-dashed border-border px-4 py-5 text-center hover:border-border-hover"
                  : "min-h-12 rounded-b-xl px-3 py-2 text-left"
              }`}
              onClick={() => {
                void browse();
              }}
            >
              {rootsEmpty ? (
                <>
                  <span className="flex size-9 items-center justify-center rounded-full bg-surface text-foreground-subtle group-hover:text-foreground">
                    <FolderPlus className="size-4" />
                  </span>
                  <span className="font-medium">{msg("projectEditor.browse")}</span>
                  <span className="text-ui-sm text-foreground-subtle">
                    {msg("projectEditor.browseHint")}
                  </span>
                </>
              ) : (
                <>
                  <FolderPlus className="size-4 shrink-0 text-foreground-subtle" />
                  <span>{msg("projectEditor.addFolder")}</span>
                </>
              )}
            </button>
          </fieldset>
          {error ? (
            <p role="alert" className="text-ui-sm text-destructive" data-testid="project-editor-error">
              {error}
            </p>
          ) : null}
          <DialogFooter className="flex-row flex-wrap items-center justify-end gap-3">
            {project ? (
              <Button
                variant="ghost"
                disabled={busy}
                data-testid="project-editor-delete"
                onClick={() => {
                  void remove();
                }}
                className="mr-auto bg-destructive-surface text-destructive-surface-foreground hover:bg-destructive-surface hover:text-destructive-surface-foreground"
              >
                {msg("projectEditor.delete")}
              </Button>
            ) : null}
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              {msg("common.cancel")}
            </Button>
            <Button
              disabled={busy || rootsEmpty}
              data-testid="project-editor-save"
              onClick={() => {
                void save();
              }}
            >
              {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
              {project ? msg("common.confirm") : msg("projectEditor.create")}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function projectEditorDisplayNamePlaceholder(form: ProjectEditorForm): string {
  return projectEditorDisplayName(form) || "";
}
