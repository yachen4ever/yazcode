import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type { ProjectRecord, SaveProjectInput } from "../session/projectRepository.js";

export type { ProjectRecord, ProjectRoot, SaveProjectInput } from "../session/projectRepository.js";

/** prepareSession 的产物：新任务 cwd 与附加目录的唯一权威来源（docs/specs/multi-root-projects.md）。 */
export interface PreparedProjectSession {
  projectId: string;
  /** = 项目 primary root；主目录在文件系统上缺失时 prepareSession 直接拒绝。 */
  workspacePath: string;
  /** 其余 roots（有序、已排除 primary）。 */
  additionalDirectories: string[];
}

export interface ResolveSessionDirectoriesInput {
  projectId: string;
  /** 任务行固化的 cwd；缺省回退项目当前 primary。 */
  taskWorkspacePath?: string;
  /** 任务行固化的附加目录 JSON；存在即优先，改项目 roots 不改写旧任务。 */
  taskExecutionDirectories?: string | null;
}

export interface ResolvedSessionDirectories {
  projectId: string;
  workspacePath: string;
  additionalDirectories: string[];
  /** true = 来自任务行固化值；false = 按项目当前 roots 现算（冷恢复补齐路径）。 */
  fromTaskRecord: boolean;
}

/**
 * 项目服务（多目录项目 P1b）。仓储语义见 ProjectRepository；本层补文件系统事实
 * （primary 存活性）与目录解析优先级，供任务创建/恢复链路调用。UI 面向的
 * saveProject/listProjects 同样经此入口，P3 项目编辑器直接消费。
 */
export interface IProjectService {
  saveProject(input: SaveProjectInput): Promise<ProjectRecord>;
  getProject(projectId: string): Promise<ProjectRecord>;
  listProjects(): Promise<ProjectRecord[]>;
  deleteProject(projectId: string): Promise<void>;
  prepareSession(input: { projectId: string }): Promise<PreparedProjectSession>;
  resolveSessionDirectories(
    input: ResolveSessionDirectoriesInput,
  ): Promise<ResolvedSessionDirectories>;
  adoptRecentProjects(paths: readonly string[]): Promise<number>;
}

export const IProjectService = createServiceDescriptor<IProjectService>(ServiceChannels.Project);
