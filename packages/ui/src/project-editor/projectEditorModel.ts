import type { ProjectRecord, SaveProjectInput } from "@zcode/services";
import { leafNameOf } from "@/lib/projectPresentation.js";

/**
 * 项目编辑器表单模型（docs/specs/multi-root-projects.md「P3b 项目编辑器」）。
 *
 * 表单态是对话框局部 state（状态所有者是 ProjectEditorDialog）；本模块只做纯迁移，
 * 服务写路径在组件层经 IProjectService 完成。去重在 UI 层先行，Repository 层
 * `saveProject` 仍会兜底去重（双层防御，spec 契约）。
 */

export interface ProjectEditorForm {
  /** 空串表示沿用默认名（首个 root 的 basename）。 */
  name: string;
  /** 用户是否显式改名；未改名时保存不携带 name，由服务默认名语义接管。 */
  nameEdited: boolean;
  /** 有序 roots（已按绝对路径去重）。 */
  roots: string[];
  /** 主目录；始终是 roots 成员，移除时回落首个 root。 */
  primaryRoot: string;
}

export function createProjectEditorForm(
  project: ProjectRecord | null,
  initialRoots: readonly string[] = [],
): ProjectEditorForm {
  if (project) {
    const roots = project.roots.map((root) => root.rootPath);
    return {
      name: project.name,
      nameEdited: false,
      roots,
      primaryRoot:
        project.roots.find((root) => root.isPrimary)?.rootPath ?? roots[0] ?? "",
    };
  }
  const roots = [...new Set(initialRoots.map((root) => root.trim()).filter(Boolean))];
  return {
    name: "",
    nameEdited: false,
    roots,
    primaryRoot: roots[0] ?? "",
  };
}

/** 追加目录：trim、滤空、去重保序；首个 root 自动成为主目录。 */
export function addRootsToForm(
  form: ProjectEditorForm,
  paths: readonly string[],
): ProjectEditorForm {
  const incoming = paths.map((path) => path.trim()).filter(Boolean);
  if (incoming.length === 0) return form;
  const roots = [...new Set([...form.roots, ...incoming])];
  return {
    ...form,
    roots,
    primaryRoot: form.primaryRoot || roots[0] || "",
  };
}

/** 移除目录；被移除的是主目录时回落首个 root（spec：主目录被移除时回落首个 root）。 */
export function removeRootFromForm(
  form: ProjectEditorForm,
  rootPath: string,
): ProjectEditorForm {
  const roots = form.roots.filter((root) => root !== rootPath);
  const primaryRoot =
    form.primaryRoot === rootPath ? (roots[0] ?? "") : form.primaryRoot;
  return { ...form, roots, primaryRoot };
}

export function setPrimaryRootInForm(
  form: ProjectEditorForm,
  rootPath: string,
): ProjectEditorForm {
  if (!form.roots.includes(rootPath)) return form;
  return { ...form, primaryRoot: rootPath };
}

export function renameProjectInForm(
  form: ProjectEditorForm,
  name: string,
): ProjectEditorForm {
  return { ...form, name, nameEdited: true };
}

/** 保存载荷；roots 为空即不能保存（服务端同样拒绝，UI 先行禁用）。 */
export function buildProjectSaveInput(
  form: ProjectEditorForm,
  options?: { projectId?: string },
): SaveProjectInput | null {
  const roots = [...new Set(form.roots.map((root) => root.trim()).filter(Boolean))];
  if (roots.length === 0) return null;
  const primary = form.primaryRoot.trim();
  return {
    ...(options?.projectId ? { projectId: options.projectId } : {}),
    // 服务契约 name 必填：显式改名用新名，否则沿用展示名（主目录 leaf）。
    name: form.nameEdited && form.name.trim() ? form.name.trim() : projectEditorDisplayName(form),
    roots,
    ...(primary && roots.includes(primary) ? { primaryRoot: primary } : {}),
  };
}

/** 表单展示名：显式改名用 name，否则回落首个 root 的 basename（与 ZCodium 同语义）。 */
export function projectEditorDisplayName(form: ProjectEditorForm): string {
  const name = form.name.trim();
  if (name) return name;
  return leafNameOf(form.primaryRoot || form.roots[0] || "");
}

const PROJECT_ERROR_I18N_KEYS: ReadonlyMap<string, string> = new Map([
  ["project.roots-empty", "projectEditor.error.rootsEmpty"],
  ["project.primary-not-in-roots", "projectEditor.error.primaryNotInRoots"],
  ["project.primary-root-missing", "projectEditor.error.primaryRootMissing"],
  ["project.service-unavailable", "projectEditor.error.serviceUnavailable"],
]);

/**
 * 服务错误 → i18n 键。仓储/服务错误消息形如 `project.roots-empty: detail` 或
 * `project.primary-root-missing: /path`；未知错误回落通用失败文案。
 */
export function projectEditorErrorKey(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  for (const [code, key] of PROJECT_ERROR_I18N_KEYS) {
    if (message === code || message.startsWith(`${code}:`) || message.includes(code)) {
      return key;
    }
  }
  return "projectEditor.error.saveFailed";
}
