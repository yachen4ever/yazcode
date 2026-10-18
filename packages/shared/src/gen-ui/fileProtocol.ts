/**
 * gen-ui 文件协议（渲染侧与主进程共用）。
 * URL 携带执行端绝对路径（query 编码），主进程是唯一授权点：
 * 根目录校验、符号链接拒绝、类型与体积限制都在协议处理器完成。
 */
export const GEN_UI_FILE_SCHEME = "gen-ui";

export function buildGenUiFileUrl(path: string): string {
  return `${GEN_UI_FILE_SCHEME}://local/file?path=${encodeURIComponent(path)}`;
}
