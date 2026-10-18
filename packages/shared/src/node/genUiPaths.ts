import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { buildGenUiScopeKey, genUiScopeSchema, type GenUiScope } from "../gen-ui/index.js";

/** 执行 Host 提供的进程级输出根；模型永不选择它。 */
export const GEN_UI_OUTPUT_ROOT_ENV = "ZCODE_GEN_UI_OUTPUT_ROOT";
export const GEN_UI_OUTPUT_DIRECTORY = "visualizations";

export function getGenUiOutputDirectory(outputRoot: string, scope: GenUiScope): string {
  genUiScopeSchema.parse(scope);
  if (!isAbsolute(outputRoot) || !isAbsolute(scope.workspacePath))
    throw new Error("Gen UI output root and workspace must be absolute");
  const root = resolve(outputRoot);
  // 固定输出目录不是"必须在工作区之外"的限制：目录由 Host 决定，
  // 工作区可以包含它；workspace/session 子目录只负责组织生成文件，不是读取授权边界。
  return join(root, createHash("sha256").update(buildGenUiScopeKey(scope)).digest("hex"));
}
