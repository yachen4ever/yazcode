import type { ProjectRecord } from "./projectRepository.js";

/**
 * 远程单 root 策略（docs/specs/multi-root-projects.md「远程边界（P4）」）。
 *
 * 原样移植自上游 ZCodium packages/services/src/project-storage/remote-policy.ts
 * （接线提交 b0de1476）：两个纯断言函数逐行保留，仅类型导入从上游 VirtualProject
 * （contract.js）改指本仓 ProjectRecord——结构性兼容，policy 只读 roots[].rootPath。
 * 零运行时依赖不变（编译后无 import）。
 */

/** 远端限制必须依据持库宿主，不能让请求中的 hostId 或 addMissingRoot 绕过。 */
export function assertRemoteProjectRoots(
  ownerHostId: string | undefined,
  roots: readonly string[],
  previous?: ProjectRecord,
): void {
  if (!ownerHostId || ownerHostId === "local") return;
  if (roots.length !== 1) throw new Error("project.remote-single-root-required");
  if (previous && (previous.roots.length !== 1 || previous.roots[0]?.rootPath !== roots[0]))
    throw new Error("project.remote-root-immutable");
}

/** 新建、移动和恢复共用约束；固定执行配置也不能给远端会话增加第二个目录。 */
export function assertRemoteTaskDirectories(
  ownerHostId: string | undefined,
  project: ProjectRecord | null | undefined,
  workspacePath: string,
  additionalDirectories: readonly string[] = [],
): void {
  if (!ownerHostId || ownerHostId === "local") return;
  if (!project) throw new Error("project.remote-project-required");
  assertRemoteProjectRoots(
    ownerHostId,
    project.roots.map((root) => root.rootPath),
  );
  if (additionalDirectories.length) throw new Error("project.remote-single-root-required");
  if (project.roots[0]?.rootPath !== workspacePath) throw new Error("project.cwd-not-in-roots");
}

/**
 * 本仓新增口径（上游按仓储属主 ownerHostId 判远端，本仓按项目行 host_id 承载远端
 * 事实）：undefined/空串/"local" 即本地（不约束），其余即远端。服务与 UI 复用
 * 这一个判定，不得各自手写口径。
 */
export function isRemoteProjectHostId(hostId: string | null | undefined): boolean {
  const normalized = hostId?.trim();
  return Boolean(normalized) && normalized !== "local";
}
