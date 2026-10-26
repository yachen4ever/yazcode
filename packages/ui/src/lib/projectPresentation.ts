import type { ProjectRecord } from "@zcode/services";

/**
 * 多目录项目 P3a 呈现层纯函数（docs/specs/multi-root-projects.md「P3 总则」）。
 *
 * 项目事实的唯一持久所有者是 ProjectRepository（tasks-index.sqlite）；本文件只做
 * 派生投影：workspace → project 的呈现层关联、roots 展示切片。所有函数同输入同输出，
 * 不触碰服务、不落盘。
 */

/** 项目主目录；roots 契约保证 isPrimary 唯一，缺失时回落首个 root 兜底。 */
export function primaryRootOf(project: ProjectRecord): string | null {
  return (
    project.roots.find((root) => root.isPrimary)?.rootPath ?? project.roots[0]?.rootPath ?? null
  );
}

/** 项目其余 roots（有序、排除主目录）；供提及范围与 roots 徽标消费。 */
export function additionalRootsOf(project: ProjectRecord): string[] {
  const primary = primaryRootOf(project);
  return project.roots
    .map((root) => root.rootPath)
    .filter((rootPath) => rootPath !== primary);
}

/** 项目全部 roots，主目录在前；无项目返回 null。 */
export function orderedRootsOf(project: ProjectRecord | null): string[] | null {
  if (!project) return null;
  const primary = primaryRootOf(project);
  if (primary === null) return null;
  return [primary, ...additionalRootsOf(project)];
}

/**
 * workspace → 项目的呈现层关联：primary root 与 workspacePath 相同即视为该
 * workspace 的项目上下文（多 root 会话的 workspaceKey 天然落 primary root，P1b-2）。
 *
 * 同 cwd 双项目时取确定性选择：pinned 优先，其次 projectId 字典序——只用于标注与
 * roots 提示，任务归属仍以任务行固化的 projectId 为准（spec G1）。
 */
export function resolveProjectForWorkspacePath(
  projects: readonly ProjectRecord[],
  workspacePath: string,
): ProjectRecord | null {
  const normalized = workspacePath.trim();
  if (!normalized) return null;
  const candidates = projects.filter((project) => primaryRootOf(project) === normalized);
  if (candidates.length === 0) return null;
  return [...candidates].sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    return left.projectId < right.projectId ? -1 : left.projectId > right.projectId ? 1 : 0;
  })[0] as ProjectRecord;
}

/** 侧栏行的项目显示名：项目名优先，缺省名回落，与 Repository 默认名语义对齐。 */
export function projectDisplayName(project: ProjectRecord): string {
  const name = project.name.trim();
  if (name) return name;
  return project.defaultName?.trim() || leafNameOf(primaryRootOf(project) ?? project.projectId);
}

/** 路径 leaf（basename）；统一用 `/` 与 `\` 两种分隔符，不引入 node:path（renderer/web 共用）。 */
export function leafNameOf(path: string): string {
  const normalized = path.trim();
  if (!normalized) return "";
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? normalized;
}

/** roots 徽标：单 root 不显示，多 root 显示总数；tooltip 文案由调用方按 roots 拼装。 */
export function projectRootsBadgeCount(project: ProjectRecord): number | null {
  const count = project.roots.length;
  return count > 1 ? count : null;
}
