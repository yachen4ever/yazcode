import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { additionalDirectoryNamespace } from "@zcode/contracts";
import type { SkillRoot, SkillSource } from "@zcode/contracts";

const GIT_MARKER = ".git";
const HOME_PREFIX = "~/";
const PRIORITY_STEP = 10;
const SKILLS_DIR = "skills";
const USER_ZCODE_DIR = ".yazcode";
const PROJECT_ZCODE_DIR = ".zcode";
const AGENTS_DIR = ".agents";

export interface SkillRootResolutionOptions {
  homeDirectory?: string;
  extraRoots?: string[];
  extraResolvedRoots?: SkillRoot[];
  includeZcodeSkills?: boolean;
  /**
   * 多目录项目附加目录（docs/specs/multi-root-projects.md 信任边界白名单）：
   * 仅 skills 发现消费；每目录追加 `.zcode/skills` 与 `.agents/skills` project 根，
   * namespace = basename(目录)，排在 cwd 链之后（cwd 同名优先）。
   */
  additionalDirectories?: readonly string[];
}

export async function resolveDefaultSkillRoots(
  workingDirectory: string,
  options: SkillRootResolutionOptions = {},
): Promise<SkillRoot[]> {
  const resolvedWorkingDirectory = resolve(workingDirectory);
  const roots: SkillRoot[] = [];
  const includeZcode = options.includeZcodeSkills ?? true;
  const home = options.homeDirectory ?? homedir();
  let priority = 0;
  const nextPriority = () => {
    priority += PRIORITY_STEP;
    return priority;
  };

  for (const extraRoot of options.extraRoots ?? []) {
    roots.push(
      root(
        resolveConfiguredRoot(extraRoot, resolvedWorkingDirectory),
        "project",
        "zcode",
        nextPriority(),
      ),
    );
  }

  if (includeZcode) {
    roots.push(...skillRootsForBase(home, "user", nextPriority));
  }

  const projectDirectories = await resolveProjectSkillDirectories(resolvedWorkingDirectory);
  for (const directory of projectDirectories) {
    if (includeZcode) {
      roots.push(...skillRootsForBase(directory, "project", nextPriority));
    }
  }

  // 多目录项目附加目录（信任边界白名单：只进 skills/commands/subagents 发现与 env-info）：
  // 与 cwd 的 project 根同构（.zcode + .agents 双生态），namespace 限定来源；
  // 排在 cwd 链之后，同名技能 cwd 优先，附加目录侧以 `<namespace>:<name>` 可辨。
  for (const additionalDirectory of options.additionalDirectories ?? []) {
    const base = resolve(additionalDirectory);
    if (base === resolvedWorkingDirectory) continue;
    if (includeZcode) {
      roots.push(
        root(join(base, PROJECT_ZCODE_DIR, SKILLS_DIR), "project", "zcode", nextPriority(), {
          namespace: additionalDirectoryNamespace(base),
        }),
      );
      roots.push(
        root(join(base, AGENTS_DIR, SKILLS_DIR), "project", "agents", nextPriority(), {
          namespace: additionalDirectoryNamespace(base),
        }),
      );
    }
  }

  roots.push(...(options.extraResolvedRoots ?? []));

  return roots;
}

async function resolveProjectSkillDirectories(workingDirectory: string): Promise<string[]> {
  const worktreeRoot = await findWorktreeRoot(workingDirectory);
  if (!worktreeRoot) return [workingDirectory];

  const directories: string[] = [];
  let current = workingDirectory;
  while (true) {
    directories.push(current);
    if (current === worktreeRoot || current === dirname(current)) break;
    current = dirname(current);
  }
  return directories;
}

async function findWorktreeRoot(workingDirectory: string): Promise<string | null> {
  let current = workingDirectory;
  while (true) {
    if (await pathExists(join(current, GIT_MARKER))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function skillRootsForBase(
  baseDirectory: string,
  scope: SkillRoot["scope"],
  nextPriority: () => number,
): SkillRoot[] {
  // 合并而不是 fallback：用户可能同时安装原生 `.zcode` skill 和兼容 `.agents` skill。
  // 同一级别仍保持 `.zcode` 优先，后续同名按 root 顺序解析。
  return [
    root(join(baseDirectory, scope === "user" ? USER_ZCODE_DIR : PROJECT_ZCODE_DIR, SKILLS_DIR), scope, "zcode", nextPriority()),
    root(join(baseDirectory, AGENTS_DIR, SKILLS_DIR), scope, "agents", nextPriority()),
  ];
}

function root(
  path: string,
  scope: SkillRoot["scope"],
  source: SkillSource,
  priority: number,
  extra: Pick<SkillRoot, "namespace"> = {},
): SkillRoot {
  return {
    path: resolve(path),
    scope,
    source,
    priority,
    ...extra,
  };
}

function resolveConfiguredRoot(path: string, workingDirectory: string): string {
  const expanded = path.startsWith(HOME_PREFIX)
    ? join(homedir(), path.slice(HOME_PREFIX.length))
    : path;
  return isAbsolute(expanded) ? expanded : resolve(workingDirectory, expanded);
}
