import { stat } from "node:fs/promises";
import { ProjectRepository } from "../session/projectRepository.js";
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

function parseExecutionDirectories(raw: string | null | undefined): string[] | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
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
      await assertDirectoryExists(primary);
      return {
        projectId,
        workspacePath: primary,
        additionalDirectories: project.roots
          .map((root) => root.rootPath)
          .filter((root) => root !== primary),
      };
    },
    async resolveSessionDirectories(
      input: ResolveSessionDirectoriesInput,
    ): Promise<ResolvedSessionDirectories> {
      await repository.ensureReady();
      const solidified = parseExecutionDirectories(input.taskExecutionDirectories);
      // 任务行固化值优先：改项目主目录/增删 roots 不改写旧任务（spec 数据契约）。
      if (input.taskWorkspacePath?.trim() && solidified) {
        const workspacePath = input.taskWorkspacePath.trim();
        return {
          projectId: input.projectId,
          workspacePath,
          additionalDirectories: solidified.filter((path) => path !== workspacePath),
          fromTaskRecord: true,
        };
      }
      const project = repository.getProject(input.projectId);
      const workspacePath =
        input.taskWorkspacePath?.trim() || repository.primaryRootOf(input.projectId);
      return {
        projectId: input.projectId,
        workspacePath,
        additionalDirectories: project.roots
          .map((root) => root.rootPath)
          .filter((root) => root !== workspacePath),
        fromTaskRecord: false,
      };
    },
    async adoptRecentProjects(paths) {
      await repository.ensureReady();
      return repository.adoptRecentProjects(paths);
    },
  };
}
