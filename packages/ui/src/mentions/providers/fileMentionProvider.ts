import { useEffect, useMemo, useState } from "react";
import type { WorkspaceFileEntry } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import { buildFileMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import { WORKSPACE_FILE_SEARCH_DISPLAY_CAP } from "@zcode/shared/workspaceFileSearch";
import { getMentionGroupLimitForQuery } from "@/mentions/mentionSearch.js";
import type { MentionCategoryResult, MentionItem } from "@/mentions/mentionTypes.js";
import { leafNameOf } from "@/lib/projectPresentation.js";

function mapWorkspaceFileToMentionItem(entry: WorkspaceFileEntry): MentionItem {
  return {
    id: `file:${entry.relativePath}`,
    category: "files",
    label: entry.name,
    description: entry.relativePath,
    value: entry.relativePath,
    // 文件 mention 的标准转译格式需要保持 `[filename](path)`，
    // 之前这里误把整条 relativePath 当成链接文本，导致发送后回显和复制内容都退化成“长路径做标题”。
    // 这里恢复为只用 basename 做 label，路径只放在链接目标里，和输入框 node 样式保持一致。
    markdown: buildFileMentionMarkdown(entry.relativePath, entry.name, entry.type),
    keywords: [entry.relativePath, entry.path],
    data: {
      kind: entry.type,
      path: entry.path,
      relativePath: entry.relativePath,
    },
  };
}

/**
 * 附加 root 的文件命中（P3d 文件提及跨 roots）：非 cwd root 的提及用绝对路径引用，
 * 并以 rootName（basename）标注来源。cwd 命中保持相对路径语义不变。
 * 导出供测试（spec 验收：绝对路径引用 + 来源标注）。
 */
export function mapAdditionalRootFileToMentionItem(
  entry: WorkspaceFileEntry,
  rootPath: string,
): MentionItem {
  const rootName = leafNameOf(rootPath);
  const absolutePath =
    entry.type === "directory" ? `${entry.path.replace(/[\\/]+$/, "")}/` : entry.path;
  return {
    id: `file:${entry.path}`,
    category: "files",
    label: entry.name,
    description: `${rootName}/${entry.relativePath}`,
    value: entry.path,
    markdown: buildFileMentionMarkdown(absolutePath, entry.name, entry.type),
    keywords: [entry.relativePath, entry.path, rootName],
    data: {
      kind: entry.type,
      path: entry.path,
      relativePath: entry.relativePath,
    },
  };
}

function normalizeRefreshQuery(query: string): string {
  return query.trim().toLowerCase();
}

export function useFileMentionProvider(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  query: string,
  enabled: boolean,
  emptyText: string,
  title: string,
  defaultPreviewLimit?: number,
  additionalRoots?: readonly string[],
): MentionCategoryResult {
  const { fileService } = useServices();
  const limit =
    getMentionGroupLimitForQuery(query, defaultPreviewLimit) ?? WORKSPACE_FILE_SEARCH_DISPLAY_CAP;
  // 附加 roots 按内容去身份化：调用方传新数组引用不应触发重新搜索。
  const additionalRootsKey = useMemo(
    () => (additionalRoots ? [...new Set(additionalRoots)].join("\u0000") : ""),
    [additionalRoots],
  );
  // 连接实例也属于作用域：相同路径的远程重连不能接纳旧 Host 的查询结果。
  const scope = useMemo(
    () => ({
      error: null as Error | null,
      lastMissQuery: null as string | null,
    }),
    [fileService, workspacePath, workspaceIdentity, enabled],
  );
  const [result, setResult] = useState<{
    scope: typeof scope;
    query: string;
    limit: number;
    additionalRootsKey: string;
    items: MentionItem[];
    loading: boolean;
  } | null>(null);

  useEffect(() => {
    // 错误态等待面板/工作区/连接生命周期重置，避免 query 变化触发失败重试循环。
    if (!enabled || scope.error) return;
    let active = true;
    setResult({ scope, query, limit, additionalRootsKey, items: [], loading: true });
    const params = { rootPath: workspacePath, workspaceIdentity, query, limit };
    const additionalRootPaths = additionalRootsKey ? additionalRootsKey.split("\u0000") : [];
    const search = async () => {
      try {
        // cwd 与附加 roots 并发搜索；附加 root 失败（目录缺失/权限）降级为该 root
        // 静默缺席，不阻塞 cwd（spec P3d）。附加 root 不携带 workspaceIdentity
        // （非注册 workspace），也不做补扫重试。
        const [cwdEntries, additionalResults] = await Promise.all([
          fileService.searchWorkspaceFiles(params),
          Promise.all(
            additionalRootPaths.map(async (rootPath) => {
              try {
                return {
                  rootPath,
                  entries: await fileService.searchWorkspaceFiles({ rootPath, query, limit }),
                };
              } catch {
                return { rootPath, entries: [] as WorkspaceFileEntry[] };
              }
            }),
          ),
        ]);
        if (!active) return;
        // 按绝对路径去重，cwd 命中优先（spec P3d）。
        const seenPaths = new Set(cwdEntries.map((entry) => entry.path));
        const items: MentionItem[] = cwdEntries.map(mapWorkspaceFileToMentionItem);
        for (const { rootPath, entries } of additionalResults) {
          for (const entry of entries) {
            if (seenPaths.has(entry.path)) continue;
            seenPaths.add(entry.path);
            items.push(mapAdditionalRootFileToMentionItem(entry, rootPath));
          }
        }
        const normalizedQuery = normalizeRefreshQuery(query);
        if (cwdEntries.length === 0 && normalizedQuery && scope.lastMissQuery !== normalizedQuery) {
          scope.lastMissQuery = normalizedQuery;
          // 无命中补扫必须绕过 Host TTL，否则外部新文件在缓存有效期内永远不可见。
          // 补扫只针对 cwd root；附加 root 保持静默缺席语义。
          const refreshed = await fileService.searchWorkspaceFiles({ ...params, refresh: true });
          if (!active) return;
          const refreshedItems: MentionItem[] = [];
          for (const entry of refreshed) {
            if (seenPaths.has(entry.path)) continue;
            seenPaths.add(entry.path);
            refreshedItems.push(mapWorkspaceFileToMentionItem(entry));
          }
          items.unshift(...refreshedItems);
        }
        setResult({ scope, query, limit, additionalRootsKey, items, loading: false });
      } catch (error) {
        if (!active) return;
        scope.error = error instanceof Error ? error : new Error(String(error));
        setResult({ scope, query, limit, additionalRootsKey, items: [], loading: false });
      }
    };
    void search();
    // 查询、工作区、连接或面板生命周期变化都使已发出的异步响应失效。
    return () => {
      active = false;
    };
  }, [enabled, fileService, workspacePath, workspaceIdentity, query, limit, scope, additionalRootsKey]);

  const current =
    enabled &&
    result?.scope === scope &&
    result.query === query &&
    result.limit === limit &&
    result.additionalRootsKey === additionalRootsKey;
  return {
    items: current ? result.items : [],
    loading: enabled && !scope.error && (!current || result.loading),
    error: enabled ? scope.error : null,
    emptyText,
    title,
  };
}
