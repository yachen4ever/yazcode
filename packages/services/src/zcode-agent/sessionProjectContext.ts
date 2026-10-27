/**
 * G1（docs/specs/multi-root-projects.md）：桌面 v4 草稿首发路径的项目归属登记表。
 *
 * 链路：UI 预热 createSession 随参携带 `projectContext.projectId` → 宿主经
 * `prepareSession` 解析三件套（projectId/rootPath/executionDirectories）后按
 * **sessionId** 登记 → syncer 首次快照落库时消费盖章（取即清，防旧值复用）。
 *
 * 键控用 sessionId 而非 workspaceKey（复核 major-1）：workspaceKey 会被同
 * workspace 的无关任务回源/其他会话首写抢先消费，且 merge-preserve 下错值
 * 不可自愈。弃稿残留条目无消费者（仅占少量内存，进程重启清零）。
 *
 * 纯内存、即用即清：不落盘、不引第二持久所有者（持久态仍只有任务行固化的
 * 三件套与 ProjectRepository）。
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
