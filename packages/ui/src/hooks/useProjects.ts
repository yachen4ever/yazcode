import { useEffect, useMemo } from "react";
import type { ProjectRecord } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { useProjectStore } from "@/store/projectStore.js";
import {
  additionalRootsOf,
  orderedRootsOf,
  primaryRootOf,
  projectDisplayName,
  projectRootsBadgeCount,
  resolveProjectForWorkspacePath,
} from "@/lib/projectPresentation.js";

/**
 * 项目读模型的 React 消费面（P3a）。挂载时幂等拉取一次；此后编辑器的
 * upsert/remove action 会就地更新同一 store，多消费方（侧栏、编辑器、composer）
 * 无需各自维护请求。
 */
export function useProjects(): {
  projects: ProjectRecord[];
  status: ReturnType<typeof useProjectStore.getState>["status"];
  error: string | null;
  reload: () => Promise<void>;
} {
  const { projectService } = useServices();
  const projects = useProjectStore((state) => state.projects);
  const status = useProjectStore((state) => state.status);
  const error = useProjectStore((state) => state.error);
  const load = useProjectStore((state) => state.load);
  const refresh = useProjectStore((state) => state.refresh);

  useEffect(() => {
    void load(projectService);
  }, [load, projectService]);

  return useMemo(
    () => ({
      projects,
      status,
      error,
      reload: () => refresh(projectService),
    }),
    [projects, status, error, refresh, projectService],
  );
}

/**
 * 单个 workspace 的项目上下文（呈现层派生，spec「P3 总则」）：按 primary root
 * 匹配；远端 tab 同样生效（呈现层不假设远端单 root）。命中返回展示投影，未命中
 * 返回 null，调用方回落 workspacePath leaf。
 */
export function useWorkspaceProjectContext(
  workspacePath: string,
  options?: { workspaceIdentity?: string },
): {
  project: ProjectRecord | null;
  displayName: string | null;
  /** [workspacePath, ...其余 roots]；无项目上下文返回 null。 */
  mentionRoots: string[] | null;
  rootsBadgeCount: number | null;
  rootsTooltip: string | null;
} {
  const { projects } = useProjects();
  return useMemo(() => {
    // workspaceIdentity 是身份隔离键，不影响本地路径匹配；参数仅作文档化口径，
    // 防止调用方误把 identity 拼进路径（AGENTS.md Workspace Identity）。
    void options?.workspaceIdentity;
    const project = resolveProjectForWorkspacePath(projects, workspacePath);
    if (!project) {
      return {
        project: null,
        displayName: null,
        mentionRoots: null,
        rootsBadgeCount: null,
        rootsTooltip: null,
      };
    }
    const roots = orderedRootsOf(project) ?? [];
    return {
      project,
      displayName: projectDisplayName(project),
      mentionRoots: roots,
      rootsBadgeCount: projectRootsBadgeCount(project),
      rootsTooltip: roots.length > 1 ? roots.join("\n") : null,
    };
  }, [projects, workspacePath, options?.workspaceIdentity]);
}

export { additionalRootsOf, primaryRootOf, projectDisplayName, resolveProjectForWorkspacePath };
