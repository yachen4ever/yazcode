import { z } from "zod";

/**
 * Gen UI 会话内联可视化的 wire 契约（P1 子集，与上游 zai-org/ZCode gen-ui 对齐）。
 * P2 再引入：widget state / tweak / follow-up / presentation 等交互协议。
 */

export const GEN_UI_HTML_MAX_BYTES = 5_000_000;

/** P1 允许 fragment 加载脚本的 CDN 白名单（上游 genUiStaticDomains 原集）。 */
export const GEN_UI_STATIC_DOMAINS = [
  "cdnjs.cloudflare.com",
  "esm.sh",
  "cdn.jsdelivr.net",
  "unpkg.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "fonts.bunny.net",
] as const;

/** 这是 wire 层校验；执行端（主进程）负责归一化与文件系统授权。 */
export const genUiPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((path) => {
    if (path.includes("\0") || /[\r\n]/u.test(path)) return false;
    const segments = path.split(/[\\/]/u);
    return (
      /^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(path) &&
      !segments.includes("..") &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*\.html$/u.test(segments.at(-1) ?? "")
    );
  }, "Expected an absolute executor path to a lowercase-hyphenated HTML file");

export const genUiReferenceSchema = z
  .object({
    path: genUiPathSchema,
    title: z.string().max(250).optional(),
    mode: z.enum(["wide"]).optional(),
  })
  .strict();
export type GenUiReference = z.infer<typeof genUiReferenceSchema>;

export const genUiScopeSchema = z
  .object({
    workspacePath: z.string().min(1).max(4096),
    workspaceIdentity: z.string().max(4096).optional(),
    sessionId: z.string().min(1).max(512),
  })
  .strict();
export type GenUiScope = z.infer<typeof genUiScopeSchema>;

/**
 * 会话子目录隔离键。身份 key 统一为 identity 优先、路径兜底，
 * 与仓库 workspace identity 纪律一致。
 */
export function buildGenUiScopeKey(scope: GenUiScope): string {
  return JSON.stringify([scope.workspaceIdentity?.trim() || scope.workspacePath, scope.sessionId]);
}

export { GEN_UI_FILE_SCHEME, buildGenUiFileUrl } from "./fileProtocol.js";
