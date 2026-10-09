import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { app, session, type DownloadItem } from "electron";
import { EMBEDDED_BROWSER_PARTITION } from "./browserDataManager.js";

/**
 * IAB（内嵌浏览器）下载自动落盘。
 *
 * Electron 的 session 若没有 will-download 处理器，下载会弹原生「另存为」对话框；
 * 内嵌浏览器跑的是无人值守的办公流程（OA 附件等），弹框会卡住 agent 操作。
 * 这里在 IAB 的持久 partition 上注册处理器：一律静默保存到
 * `Downloads/yazcode/`（重名自动追加序号），不弹任何对话框、不做确认。
 *
 * fail-open：落盘目录创建失败等异常时不调用 setSavePath，退回 Electron 默认
 * 「另存为」行为——宁可弹框也不能把下载悄悄丢掉。
 */

/** Windows 文件名的非法字符与保留尾字符。 */
function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return cleaned || "download";
}

let logger: { info(message: string): void; warn(message: string): void } = {
  info: () => {},
  warn: () => {},
};

function resolveUniqueSavePath(dir: string, filename: string): string {
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  let index = 1;
  while (existsSync(candidate)) {
    candidate = path.join(dir, `${stem}(${index})${ext}`);
    index += 1;
  }
  return candidate;
}

function attachItemLogging(item: DownloadItem, savePath: string): void {
  item.once("done", (_event, state) => {
    if (state === "completed") {
      logger.info(`[iab-download] saved ${savePath}`);
    } else {
      logger.warn(`[iab-download] not completed state=${state} savePath=${savePath}`);
    }
  });
}

export function registerIabDownloadAutoSave(options?: {
  logger?: { info(message: string): void; warn(message: string): void };
}): void {
  if (options?.logger) logger = options.logger;
  const downloadSession = session.fromPartition(EMBEDDED_BROWSER_PARTITION);
  downloadSession.on("will-download", (_event, item) => {
    try {
      const dir = path.join(app.getPath("downloads"), "yazcode");
      mkdirSync(dir, { recursive: true });
      const savePath = resolveUniqueSavePath(dir, sanitizeFilename(item.getFilename()));
      item.setSavePath(savePath);
      logger.info(`[iab-download] auto save ${item.getFilename()} -> ${savePath}`);
      attachItemLogging(item, savePath);
    } catch (error) {
      // 不 setSavePath：Electron 回退到默认「另存为」对话框，下载不会丢。
      logger.warn(
        `[iab-download] auto-save unavailable, falling back to save dialog: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });
}
