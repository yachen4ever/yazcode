import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { USER_SCRIPT_MAX_SOURCE_BYTES } from "@zcode/shared";
import { computeScriptSha256 } from "./userscriptStore.js";
import { isValidUserScriptId } from "./userscriptRules.js";
import type { IabUserscriptReadResult, IabUserscriptWriteResult } from "@zcode/shared";
import type { UserscriptStorage } from "./userscriptStorage.js";

/**
 * 用户脚本的宿主文件读写通道（P4，electron-free，测试可直跑）：
 * 唯一写 `<scriptsDir>/<scriptId>.user.js` 的入口（新建 / 导入 / URL 安装 / 编辑保存共用）。
 *
 * 边界（docs/specs/iab-userscripts.md P4）：
 * - 落盘 ≠ 批准：本模块只管文件，manifest 一概不碰（patch 是 UI 经 SettingService 的职责）；
 * - 路径边界：scriptId 先过 isValidUserScriptId，写前再把解析后的绝对路径与脚本目录
 *   前缀二次比对（join 与 resolve 语义未来若变化，宁可拒绝也不越界）；
 * - 大小上限：单文件 2MB，写前拒绝，不产生半写文件（先校验、后临时文件 + rename 原子替换）；
 * - 重名显式覆盖：overwrite !== true 且目标已存在 → `exists`；覆盖前旧内容复制为
 *   `.user.js.bak`（单代，copyFile 天然覆盖旧 bak）。`.bak` 不以 `.user.js` 结尾，
 *   store 扫描器天然忽略，删除通道也不删它——spec 明确用户可手工回收。
 */

const USER_SCRIPT_FILE_SUFFIX = ".user.js";
/** 覆盖备份后缀：拼在完整文件名之后（<id>.user.js.bak），不以 .user.js 结尾、扫描器天然忽略。 */
const USER_SCRIPT_BACKUP_SUFFIX = ".bak";

export interface UserscriptFilesLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export interface UserscriptFilesOptions {
  scriptsDir: string;
  /** GM 存储端口：deleteScript 按 deleteStorage 决定是否删除 <id>.json。 */
  storage: Pick<UserscriptStorage, "deleteStorageFile">;
  logger: UserscriptFilesLogger;
}

/** 解析后的目标路径必须仍落在脚本目录内（P4 红线 4 的二次确认），否则按非法 ID 拒绝。 */
function resolveScriptFilePath(scriptsDir: string, scriptId: string): string | null {
  const resolvedDir = resolve(scriptsDir);
  const resolvedTarget = resolve(join(resolvedDir, `${scriptId}${USER_SCRIPT_FILE_SUFFIX}`));
  // 尾部补 sep：防 "userscripts-evil" 这类同前缀目录名绕过 startsWith。
  const dirPrefix = resolvedDir.endsWith(sep) ? resolvedDir : resolvedDir + sep;
  return resolvedTarget.startsWith(dirPrefix) ? resolvedTarget : null;
}

async function fileExists(path: string): Promise<boolean | null> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    return null;
  }
}

export function createUserscriptFiles(options: UserscriptFilesOptions) {
  const { scriptsDir, storage, logger } = options;

  async function readScript(scriptId: string): Promise<IabUserscriptReadResult> {
    if (!isValidUserScriptId(scriptId)) return { ok: false, error: "invalid_script_id" };
    const filePath = resolveScriptFilePath(scriptsDir, scriptId);
    if (!filePath) return { ok: false, error: "invalid_script_id" };
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { ok: false, error: "unknown_script" };
      }
      logger.warn(`[userscripts] read ${scriptId} failed: ${String(error)}`);
      return { ok: false, error: "read_failed" };
    }
    return {
      ok: true,
      content,
      sha256: computeScriptSha256(Buffer.from(content, "utf8")),
    };
  }

  async function writeScript(
    scriptId: string,
    content: string,
    overwrite: boolean,
  ): Promise<IabUserscriptWriteResult> {
    if (!isValidUserScriptId(scriptId)) return { ok: false, error: "invalid_script_id" };
    // 内容守卫在先（含大小上限）：超限内容连临时文件都不产生（P4 验收场景 6）。
    if (typeof content !== "string" || content.length === 0) {
      return { ok: false, error: "invalid_content" };
    }
    const byteLength = Buffer.byteLength(content, "utf8");
    if (byteLength > USER_SCRIPT_MAX_SOURCE_BYTES) return { ok: false, error: "too_large" };

    const filePath = resolveScriptFilePath(scriptsDir, scriptId);
    if (!filePath) return { ok: false, error: "invalid_script_id" };

    try {
      await mkdir(scriptsDir, { recursive: true });
      const exists = await fileExists(filePath);
      if (exists === null) return { ok: false, error: "write_failed" };
      if (exists && overwrite !== true) {
        // 重名覆盖必须是显式动作（P4 红线 5）：拒绝时目标文件一个字节都不动。
        return { ok: false, error: "exists" };
      }
      if (exists) {
        // 覆盖前备份旧内容为单代 .bak；copyFile 缺省覆盖即「单代，覆盖即换」。
        await copyFile(filePath, filePath + USER_SCRIPT_BACKUP_SUFFIX);
      }
      // 原子写（照 userscriptStorage.writePayload 做法）：临时文件 + rename，
      // 崩溃/并发场景不留半写文件，扫描器读到的是完整旧内容或完整新内容。
      const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tempFile, content, "utf8");
      try {
        await rename(tempFile, filePath);
      } catch (error) {
        await rm(tempFile, { force: true });
        throw error;
      }
    } catch (error) {
      logger.warn(`[userscripts] write ${scriptId} failed: ${String(error)}`);
      return { ok: false, error: "write_failed" };
    }
    logger.info(`[userscripts] wrote ${scriptId} (${byteLength} bytes, overwrite=${overwrite})`);
    return {
      ok: true,
      changed: true,
      scriptId,
      sha256: computeScriptSha256(Buffer.from(content, "utf8")),
    };
  }

  async function deleteScript(
    scriptId: string,
    deleteStorage: boolean,
  ): Promise<
    | { ok: true; deletedFile: boolean; deletedStorage: boolean }
    | { ok: false; error: "invalid_script_id" | "unknown_script" | "delete_failed" }
  > {
    if (!isValidUserScriptId(scriptId)) return { ok: false, error: "invalid_script_id" };
    const filePath = resolveScriptFilePath(scriptsDir, scriptId);
    if (!filePath) return { ok: false, error: "invalid_script_id" };

    let deletedFile = false;
    try {
      deletedFile = await rm(filePath, { force: false }).then(
        () => true,
        (error: unknown) => {
          if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
          throw error;
        },
      );
    } catch (error) {
      logger.warn(`[userscripts] delete ${scriptId} failed: ${String(error)}`);
      return { ok: false, error: "delete_failed" };
    }
    if (!deletedFile) return { ok: false, error: "unknown_script" };

    // `.bak` 刻意不删（spec P4：用户可手工回收）；GM 存储按 deleteStorage 决定。
    let deletedStorage = false;
    if (deleteStorage) {
      try {
        deletedStorage = await storage.deleteStorageFile(scriptId);
      } catch (error) {
        // 文件已删而存储删除失败：显式回 delete_failed（此时 manifest 条目已被 UI 先行移除，
        // 行会消失；存储文件残留为孤立文件，不再被执行面引用）。重试会得 unknown_script，
        // 用户可手工清理 <storageRootDir>/<scriptId>.json。
        logger.warn(`[userscripts] delete storage ${scriptId} failed: ${String(error)}`);
        return { ok: false, error: "delete_failed" };
      }
    }
    logger.info(`[userscripts] deleted ${scriptId} (storage=${deletedStorage})`);
    return { ok: true, deletedFile, deletedStorage };
  }

  return { readScript, writeScript, deleteScript };
}

export type UserscriptFiles = ReturnType<typeof createUserscriptFiles>;
