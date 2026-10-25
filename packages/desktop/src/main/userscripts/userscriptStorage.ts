import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { UserScriptStorageResult } from "./userscriptIpcContract.js";

/**
 * GM 存储的 main 侧所有者：每脚本一个 JSON 文件（<rootDir>/<scriptId>.json），
 * 按 scriptId 命名空间隔离。写路径只有本模块的 IPC handler；
 * 并发 frame 的读改写按 scriptId 串行化（进程内 promise 链），落盘用临时文件 +
 * rename 原子替换，避免并发与崩溃场景下的半写文件。
 */

/** 单脚本存储上限：超限拒绝写入（防异常脚本撑爆磁盘）。 */
export const USER_SCRIPT_STORAGE_MAX_BYTES = 2 * 1024 * 1024;

export interface UserscriptStorageLogger {
  warn: (...args: unknown[]) => void;
}

export interface UserscriptStorageOptions {
  rootDir: string;
  logger: UserscriptStorageLogger;
}

class StorageLimitError extends Error {
  constructor() {
    super("storage limit exceeded");
  }
}

type StoredPayload = Record<string, unknown>;

function isSafeScriptId(scriptId: string): boolean {
  return !scriptId.includes("/") && !scriptId.includes("\\") && !scriptId.includes("..");
}

export function createUserscriptStorage(options: UserscriptStorageOptions) {
  const { rootDir, logger } = options;
  const locks = new Map<string, Promise<unknown>>();

  function storageFilePath(scriptId: string): string {
    // scriptId 来自目录文件名 stem（无路径分隔符），这里再挡一层以防未来调用面变化。
    if (!isSafeScriptId(scriptId)) {
      throw new Error(`invalid scriptId for storage: ${scriptId}`);
    }
    return join(rootDir, `${scriptId}.json`);
  }

  function withLock<T>(scriptId: string, operation: () => Promise<T>): Promise<T> {
    const previous = locks.get(scriptId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    locks.set(scriptId, next);
    return next.finally(() => {
      if (locks.get(scriptId) === next) locks.delete(scriptId);
    });
  }

  async function readPayload(scriptId: string): Promise<StoredPayload> {
    try {
      const raw = await readFile(storageFilePath(scriptId), "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
      return parsed as StoredPayload;
    } catch (error) {
      // 不存在 = 空存储；损坏文件视为空并记录（不阻断脚本运行）。
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        logger.warn(
          `[userscripts] storage for ${scriptId} unreadable, treating as empty: ${String(error)}`,
        );
      }
      return {};
    }
  }

  async function writePayload(scriptId: string, payload: StoredPayload): Promise<void> {
    const file = storageFilePath(scriptId);
    const serialized = JSON.stringify(payload, null, 2);
    if (Buffer.byteLength(serialized, "utf8") > USER_SCRIPT_STORAGE_MAX_BYTES) {
      throw new StorageLimitError();
    }
    await mkdir(dirname(file), { recursive: true });
    const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempFile, serialized, "utf8");
    try {
      await rename(tempFile, file);
    } catch (error) {
      await rm(tempFile, { force: true });
      throw error;
    }
  }

  function failure(error: NonNullable<UserScriptStorageResult["error"]>): UserScriptStorageResult {
    return { ok: false, error };
  }

  return {
    /** GM_getValue：key 缺失时返回 ok 且不带 value（调用方取默认值）。 */
    async getValue(scriptId: string, key: string): Promise<UserScriptStorageResult> {
      try {
        return await withLock(scriptId, async () => {
          const payload = await readPayload(scriptId);
          return key in payload ? { ok: true, value: payload[key] } : { ok: true };
        });
      } catch {
        return failure("storage_error");
      }
    },

    /** GM_listValues：现存键列表（存储为空时为空数组）。 */
    async listValues(scriptId: string): Promise<UserScriptStorageResult> {
      try {
        return await withLock(scriptId, async () => {
          const payload = await readPayload(scriptId);
          return { ok: true, keys: Object.keys(payload) };
        });
      } catch {
        return failure("storage_error");
      }
    },

    /** GM_setValue：并发写按 scriptId 串行化，size 超限拒绝。 */
    async setValue(scriptId: string, key: string, value: unknown): Promise<UserScriptStorageResult> {
      try {
        return await withLock(scriptId, async () => {
          const payload = await readPayload(scriptId);
          payload[key] = value;
          await writePayload(scriptId, payload);
          return { ok: true };
        });
      } catch (error) {
        return error instanceof StorageLimitError
          ? failure("storage_limit")
          : failure("storage_error");
      }
    },

    /** GM_deleteValue：key 不存在也返回成功（幂等）。 */
    async deleteValue(scriptId: string, key: string): Promise<UserScriptStorageResult> {
      try {
        return await withLock(scriptId, async () => {
          const payload = await readPayload(scriptId);
          if (!(key in payload)) return { ok: true };
          delete payload[key];
          if (Object.keys(payload).length === 0) {
            // 空存储直接删文件，避免残留空 JSON。
            await rm(storageFilePath(scriptId), { force: true });
          } else {
            await writePayload(scriptId, payload);
          }
          return { ok: true };
        });
      } catch {
        return failure("storage_error");
      }
    },

    /** 供诊断/测试：存储文件是否存在。 */
    async hasStorageFile(scriptId: string): Promise<boolean> {
      try {
        await stat(storageFilePath(scriptId));
        return true;
      } catch {
        return false;
      }
    },
  };
}

export type UserscriptStorage = ReturnType<typeof createUserscriptStorage>;
