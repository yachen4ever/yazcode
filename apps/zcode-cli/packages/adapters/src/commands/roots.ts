import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { additionalDirectoryNamespace } from "@zcode/contracts";
import type { CustomCommandRoot, CustomCommandSource } from "@zcode/contracts";

const COMMANDS_DIR = "commands";
const GIT_MARKER = ".git";
const HOME_PREFIX = "~/";
const PRIORITY_STEP = 10;
const USER_ZCODE_DIR = ".yazcode";
const PROJECT_ZCODE_DIR = ".zcode";
const AGENTS_DIR = ".agents";

export interface CustomCommandRootResolutionOptions {
  extraRoots?: string[];
  extraResolvedRoots?: CustomCommandRoot[];
  homeDirectory?: string;
  includeZcodeCommands?: boolean;
  /**
   * 多目录项目附加目录（docs/specs/multi-root-projects.md 信任边界白名单）：
   * 仅 commands 发现消费；每目录追加 `.zcode/commands` 与 `.agents/commands`
   * project 根（namespace = basename(目录)），排在 cwd 链之后（同名命令 cwd 优先）。
   */
  additionalDirectories?: readonly string[];
}

export async function resolveDefaultCustomCommandRoots(
  workingDirectory: string,
  options: CustomCommandRootResolutionOptions = {},
): Promise<CustomCommandRoot[]> {
  const resolvedWorkingDirectory = resolve(workingDirectory);
  const roots: CustomCommandRoot[] = [];
  const includeZcode = options.includeZcodeCommands ?? true;
  const home = options.homeDirectory ?? homedir();
  let priority = 0;
  const nextPriority = () => {
    priority += PRIORITY_STEP;
    return priority;
  };

  for (const extraRoot of options.extraRoots ?? []) {
    roots.push(
      root(
        resolveConfiguredRoot(extraRoot, resolvedWorkingDirectory, home),
        "project",
        "zcode",
        nextPriority(),
      ),
    );
  }

  if (includeZcode) {
    roots.push(...commandRootsForBase(home, "user", nextPriority));
  }

  const projectDirectories = await resolveProjectDirectories(resolvedWorkingDirectory);
  for (const directory of projectDirectories) {
    if (includeZcode) {
      roots.push(...commandRootsForBase(directory, "project", nextPriority));
    }
  }

  // 多目录项目附加目录（信任边界白名单）：与 cwd 的 project 根同构，namespace 限定来源；
  // 排在 cwd 链之后，同名命令 cwd 优先（先到先赢不变），重复项落既有 duplicate 诊断。
  for (const additionalDirectory of options.additionalDirectories ?? []) {
    const base = resolve(additionalDirectory);
    if (base === resolvedWorkingDirectory) continue;
    if (includeZcode) {
      roots.push(
        root(
          join(base, PROJECT_ZCODE_DIR, COMMANDS_DIR),
          "project",
          "zcode",
          nextPriority(),
          additionalDirectoryNamespace(base),
        ),
      );
      roots.push(
        root(
          join(base, AGENTS_DIR, COMMANDS_DIR),
          "project",
          "agents",
          nextPriority(),
          additionalDirectoryNamespace(base),
        ),
      );
    }
  }

  roots.push(...(options.extraResolvedRoots ?? []));

  return roots;
}

async function resolveProjectDirectories(workingDirectory: string): Promise<string[]> {
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

function commandRootsForBase(
  baseDirectory: string,
  scope: CustomCommandRoot["scope"],
  nextPriority: () => number,
): CustomCommandRoot[] {
  // 合并而不是 fallback：兼容 `.agents` 命令和原生 `.zcode` 命令需要同时可见。
  // 同一级别 `.zcode` 先扫描，命令同名时仍按“先到先赢”处理。
  return [
    root(join(baseDirectory, scope === "user" ? USER_ZCODE_DIR : PROJECT_ZCODE_DIR, COMMANDS_DIR), scope, "zcode", nextPriority()),
    root(join(baseDirectory, AGENTS_DIR, COMMANDS_DIR), scope, "agents", nextPriority()),
  ];
}

function root(
  path: string,
  scope: CustomCommandRoot["scope"],
  source: CustomCommandSource,
  priority: number,
  namespace?: string,
): CustomCommandRoot {
  return {
    path: resolve(path),
    scope,
    source,
    priority,
    ...(namespace ? { namespace } : {}),
  };
}

function resolveConfiguredRoot(path: string, workingDirectory: string, home: string): string {
  const expanded = path.startsWith(HOME_PREFIX) ? join(home, path.slice(HOME_PREFIX.length)) : path;
  return isAbsolute(expanded) ? expanded : resolve(workingDirectory, expanded);
}
