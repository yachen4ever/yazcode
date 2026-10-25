// ============================================================
// Context Source Port - host/workspace context boundary
// ============================================================

import type { ExecutionContext, TraceContext } from "../tracing/tracer.js";

export interface EnvInfo {
  cwd: string;
  platform: string;
  shell: string;
  osVersion: string;
  nodeVersion: string;
  /**
   * 多目录项目附加目录（docs/specs/multi-root-projects.md 信任边界白名单）：
   * 仅用于 Environment Info 段展示，不代表任何配置装配边界（config/MCP/hooks/
   * plugins/memory/permissions 仍只沿 workingDirectory 链）。
   */
  additionalDirectories?: readonly string[];
  // 执行模型不是环境事实；只能由当前 model step 的 Model 在 Prompt 渲染时提供。
  isGitRepository?: boolean;
  gitBranch?: string;
  gitMainBranch?: string;
  gitUser?: string;
  gitStatus?: "clean" | "dirty" | "not_repo";
  gitStatusLines?: string[];
  recentCommits?: string[];
}

export interface UserInstructionsOptions {
  workingDirectory: string;
  projectRoot?: string;
  priorityFiles?: string[];
  maxBytes?: number;
}

export type UserInstructionSourceScope = "user" | "workspace";

export interface ResolvedUserInstructionSource {
  scope: UserInstructionSourceScope;
  filePath: string;
  fileName: string;
  content: string;
  bytesRead: number;
  sizeBytes: number;
  truncated: boolean;
}

export interface ResolvedUserInstructions {
  filePath: string;
  fileName: string;
  content: string;
  bytesRead: number;
  sizeBytes: number;
  truncated: boolean;
  sources?: ResolvedUserInstructionSource[];
}

export type ProjectType = "node" | "python" | "rust" | "go" | "java" | "unknown";
export type PackageManager = "npm" | "yarn" | "pnpm" | "bun";

export interface ProjectContext {
  type: ProjectType;
  packageManager?: PackageManager;
  scripts?: Record<string, string>;
  buildFiles?: string[];
}

export interface ContextSourceRequest {
  workingDirectory: string;
  currentDate?: string;
  effectiveShellDisplayName?: string;
  envInfo?: EnvInfo;
  /**
   * 多目录项目附加目录（信任边界白名单：仅 env-info 展示）。runtime 从
   * AgentRuntimeConfig 透传；context source 探测 envInfo 时并入 EnvInfo.additionalDirectories。
   */
  additionalDirectories?: readonly string[];
  userInstructions?: UserInstructionsOptions;
  projectContext?: ProjectContext;
  trace?: TraceContext;
}

export interface ContextSourceDiagnostic {
  code: string;
  message: string;
  path?: string;
}

export interface ContextSourceSnapshot {
  workingDirectory: string;
  envInfo: EnvInfo;
  currentDate?: string;
  userInstructions?: ResolvedUserInstructions;
  projectContext?: ProjectContext;
  diagnostics: ContextSourceDiagnostic[];
}

export interface ContextSourceResolveOptions {
  signal?: AbortSignal;
  context?: ExecutionContext;
}

export interface ContextSourcePort {
  resolveContextSources(
    request: ContextSourceRequest,
    options?: ContextSourceResolveOptions,
  ): Promise<ContextSourceSnapshot>;
}
