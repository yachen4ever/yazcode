import { stat } from "node:fs/promises";
import { ProjectRepository } from "../session/projectRepository.js";
import { assertRemoteTaskDirectories, isRemoteProjectHostId } from "../session/remotePolicy.js";
import type {
  IProjectService,
  PreparedProjectSession,
  ResolvedSessionDirectories,
  ResolveSessionDirectoriesInput,
} from "./project.js";

/** primary root 的存活性检查：目录在文件系统上必须真实存在，缺失即拒绝、不 mkdir 复活。 */
async function assertDirectoryExists(path: string): Promise<void> {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new Error(`project.primary-root-missing: ${path}`);
  }
  if (!info.isDirectory()) throw new Error(`project.primary-root-missing: ${path}`);
}

/**
 * 任务行固化附加目录的统一解析器（L1 收敛后的唯一口径，见
 * docs/specs/multi-root-projects.md「executionDirectories 空数组语义」）：
 * - 非字符串空白串 / 非数组 JSON → null（无固化值）；
 * - 数组 → 过滤非字符串与 trim 后为空的项，空数组原样返回（固化了「显式空」）；
 * - 接受两种输入形态：列原始 JSON 文本（string）与 taskIndexRepo 已解析的 meta 数组。
 */
function parseExecutionDirectories(
  raw: string | readonly string[] | null | undefined,
): string[] | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") {
    return raw.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  }
  if (raw.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  } catch {
    return null;
  }
}

export function createProjectService(repository: ProjectRepository): IProjectService {
  return {
    async saveProject(input) {
      await repository.ensureReady();
      return repository.saveProject(input);
    },
    async getProject(projectId) {
      await repository.ensureReady();
      return repository.getProject(projectId);
    },
    async listProjects() {
      await repository.ensureReady();
      return repository.listProjects();
    },
    async deleteProject(projectId) {
      await repository.ensureReady();
      repository.deleteProject(projectId);
    },
    async prepareSession({ projectId }): Promise<PreparedProjectSession> {
      await repository.ensureReady();
      const project = repository.getProject(projectId);
      const primary = project.roots.find((root) => root.isPrimary)?.rootPath;
      // 主目录缺失即拒绝创建：不静默 mkdir 复活、不回落其他 root（spec 会话契约）。
      if (!primary) throw new Error(`project.primary-root-missing: ${projectId}`);
      // 远端项目跳过本地存活性检查：stat 打在桌面宿主上对远端路径必然 miss，
      // 目录存活由远端 CLI 的 cwd 校验兜底（spec「远程边界（P4）」）。
      if (!isRemoteProjectHostId(project.hostId)) await assertDirectoryExists(primary);
      const additionalDirectories = project.roots
        .map((root) => root.rootPath)
        .filter((root) => root !== primary);
      // 远端数据被外部篡改成多 root / cwd 漂移时在此拒绝；本地恒通过（P4 兜底断言）。
      assertRemoteTaskDirectories(project.hostId, project, primary, additionalDirectories);
      return { projectId, workspacePath: primary, additionalDirectories };
    },
    async resolveSessionDirectories(
      input: ResolveSessionDirectoriesInput,
    ): Promise<ResolvedSessionDirectories> {
      await repository.ensureReady();
      const solidified = parseExecutionDirectories(input.taskExecutionDirectories);
      // 任务行固化值优先：改项目主目录/增删 roots 不改写旧任务（spec 数据契约）。
      if (input.taskWorkspacePath?.trim() && solidified) {
        const workspacePath = input.taskWorkspacePath.trim();
        const additionalDirectories = solidified.filter((path) => path !== workspacePath);
        if (additionalDirectories.length > 0) {
          // P2 早返回语义保持不动（本地删项目 + 固化非空仍可恢复）：仅在固化附加
          // 目录非空——远端任务行构造上不可达的状态——取项目行做防御位；项目行
          // 缺失（已删）或本地项目维持 P2 原样返回（spec「远程边界（P4）」）。
          const project = repository.findProject(input.projectId);
          if (project && isRemoteProjectHostId(project.hostId)) {
            assertRemoteTaskDirectories(
              project.hostId,
              project,
              workspacePath,
              additionalDirectories,
            );
          }
        }
        return {
          projectId: input.projectId,
          workspacePath,
          additionalDirectories,
          fromTaskRecord: true,
        };
      }
      const project = repository.getProject(input.projectId);
      const workspacePath =
        input.taskWorkspacePath?.trim() || repository.primaryRootOf(input.projectId);
      const additionalDirectories = project.roots
        .map((root) => root.rootPath)
        .filter((root) => root !== workspacePath);
      // 现算路径项目已取：远端 root 与 cwd 不一致 → cwd-not-in-roots，附加目录
      // 非空 → remote-single-root-required；本地项目恒通过（spec「远程边界（P4）」）。
      assertRemoteTaskDirectories(project.hostId, project, workspacePath, additionalDirectories);
      return {
        projectId: input.projectId,
        workspacePath,
        additionalDirectories,
        fromTaskRecord: false,
      };
    },
    async adoptRecentProjects(paths) {
      await repository.ensureReady();
      return repository.adoptRecentProjects(paths);
    },
  };
}
