import { copyFile, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { SaveFileRequest, SaveFileResult } from "@zcode/shared";
import { PlatformChannels } from "@zcode/shared";
import { BrowserWindow, dialog, ipcMain } from "electron";
import { fetchRemoteWithGuard, RemoteFetchError } from "./remoteFetchGuard.js";

const MAX_SAVE_FILE_BYTES = 50 * 1024 * 1024;
const REMOTE_DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_REMOTE_REDIRECTS = 5;

class SaveFileError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function parseRemoteImageUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * SSRF 守卫（BlockList + DNS 钉扎 + manual redirect 逐跳校验）已提取到
 * remoteFetchGuard.ts，与 P4 的用户脚本 URL 安装共用同一实现。本文件只保留
 * 保存通道自身的编排（临时文件流式落盘 + 目标复制）与 SaveFileError 语义映射。
 */
function guardErrorToSaveFileError(error: unknown): unknown {
  if (!(error instanceof RemoteFetchError)) return error;
  // 保持既有 SaveFileError 语义不变：协议/重定向/资源异常 → download_failed，
  // 超时原本落通用 catch → write_failed，超限 → file_too_large。
  switch (error.code) {
    case "too_large":
      return new SaveFileError("file_too_large");
    case "timeout":
      return new SaveFileError("write_failed");
    case "remote_address_not_allowed":
      return new SaveFileError(error.code);
    default:
      return new SaveFileError("download_failed");
  }
}

async function downloadRemoteFile(sourceUrl: URL, destinationPath: string): Promise<void> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "zcode-save-file-"));
  const temporaryPath = join(temporaryDirectory, "download");
  let file: Awaited<ReturnType<typeof open>> | null = null;
  try {
    file = await open(temporaryPath, "wx");
    // renderer 的 CORS 边界不能放大成 main 可访问内网：初始地址和每次重定向都先解析
    // 并拒绝非公网地址，DNS 结果钉扎到连接；守卫边读边计数（50MB 上限）并逐块转发到此落盘。
    const result = await fetchRemoteWithGuard(
      sourceUrl,
      {
        allowedProtocols: ["http:", "https:"],
        maxRedirects: MAX_REMOTE_REDIRECTS,
        maxBytes: MAX_SAVE_FILE_BYTES,
        timeoutMs: REMOTE_DOWNLOAD_TIMEOUT_MS,
      },
      async (chunk) => {
        await file?.write(chunk);
      },
    );
    if (result.totalBytes === 0) throw new SaveFileError("invalid_file_payload");
    await copyFile(temporaryPath, destinationPath);
  } catch (error) {
    throw guardErrorToSaveFileError(error);
  } finally {
    await file?.close().catch(() => undefined);
    await rm(temporaryDirectory, { force: true, recursive: true }).catch(() => undefined);
  }
}

export function registerDesktopSaveFileIpcHandler(logger: { warn: (...args: unknown[]) => void }) {
  ipcMain.handle(
    PlatformChannels.SaveFile,
    async (event, payload: SaveFileRequest): Promise<SaveFileResult> => {
      if (!payload || typeof payload.suggestedName !== "string") {
        return { success: false, error: "invalid_file_payload" };
      }
      const suggestedName = basename(payload.suggestedName.trim()).slice(0, 120);
      const sourceUrl = parseRemoteImageUrl(payload.sourceUrl);
      const hasData = payload.data instanceof ArrayBuffer;
      if (!suggestedName || (sourceUrl === null && !hasData)) {
        return { success: false, error: "invalid_file_payload" };
      }
      if (hasData && payload.data.byteLength === 0) {
        return { success: false, error: "invalid_file_payload" };
      }
      if (hasData && payload.data.byteLength > MAX_SAVE_FILE_BYTES) {
        return { success: false, error: "file_too_large" };
      }

      const senderWindow = BrowserWindow.fromWebContents(event.sender);
      const dialogOptions = { defaultPath: suggestedName };
      const result = senderWindow
        ? await dialog.showSaveDialog(senderWindow, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions);
      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true };
      }

      try {
        if (sourceUrl) {
          await downloadRemoteFile(sourceUrl, result.filePath);
        } else if (hasData) {
          await writeFile(result.filePath, new Uint8Array(payload.data));
        }
        return { success: true, path: result.filePath };
      } catch (error) {
        const errorCode = error instanceof SaveFileError ? error.code : "write_failed";
        logger.warn(
          `[save-file] 写入失败 path=${result.filePath} error=${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return { success: false, error: errorCode };
      }
    },
  );
}
