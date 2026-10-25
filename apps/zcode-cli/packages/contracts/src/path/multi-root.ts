// ============================================================
// Multi-root projects - additional directory namespace helpers
// ============================================================

/**
 * 多目录项目附加目录的来源限定（docs/specs/multi-root-projects.md 信任边界）：
 * namespace = basename(目录)。skills/commands/subagents 三处发现点共用同一口径，
 * 使同名能力的来源可辨。纯字符串实现（兼容 Windows 反斜杠），不依赖 node:path，
 * 与本包其余模块一致保持环境无关。
 */
export function additionalDirectoryNamespace(directory: string): string {
  const segments = directory.split(/[\\/]+/u).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? directory;
}
