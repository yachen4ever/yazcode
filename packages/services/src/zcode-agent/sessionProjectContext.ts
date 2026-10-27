/**
 * G1（docs/specs/multi-root-projects.md）：桌面 v4 草稿首发路径的项目归属登记表。
 *
 * 链路：UI 预热 createSession 随参携带 `projectContext.projectId` → 宿主经
 * `prepareSession` 解析三件套（projectId/rootPath/executionDirectories）后按
 * workspaceKey 登记 → syncer 首次快照落库时消费盖章（取即清，防旧值复用）。
 *
 * 纯内存、即用即清：不落盘、不引第二持久所有者（持久态仍只有任务行固化的
 * 三件套与 ProjectRepository）。同 cwd 双项目并发首发的交叠竞态为已知边界
 * （spec 验收场景注记）。
 */
export interface ResolvedSessionProjectContext {
  projectId: string;
  rootPath: string;
  executionDirectories: string[];
}

export interface SessionProjectContextRegistry {
  register(workspaceKey: string, context: ResolvedSessionProjectContext): void;
  consume(workspaceKey: string): ResolvedSessionProjectContext | undefined;
}

export function createSessionProjectContextRegistry(): SessionProjectContextRegistry {
  const entries = new Map<string, ResolvedSessionProjectContext>();
  return {
    register(workspaceKey, context) {
      entries.set(workspaceKey, context);
    },
    consume(workspaceKey) {
      const context = entries.get(workspaceKey);
      entries.delete(workspaceKey);
      return context;
    },
  };
}
