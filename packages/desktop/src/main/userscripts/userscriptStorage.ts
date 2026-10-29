import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isValidUserScriptId } from "./userscriptRules.js";
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

/** 存储文件损坏（JSON 解析失败 / 顶层形状非法）：显式失败，不静默当空（复核 m2-5）。 */
class StorageCorruptError extends Error {
  constructor(scriptId: string) {
    super(`storage file for ${scriptId} is corrupt`);
  }
}

type StoredPayload = Record<string, unknown>;

export function createUserscriptStorage(options: UserscriptStorageOptions) {
  const { rootDir, logger } = options;
  const locks = new Map<string, Promise<unknown>>();

  function storageFilePath(scriptId: string): string {
    // scriptId 校验共用 userscriptRules 的唯一实现（P4 行为规则 3，不复制规则）；
    // 扫描来源的 id 来自文件名 stem 天然合法，这里再挡一层以防未来调用面变化。
    if (!isValidUserScriptId(scriptId)) {
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
    let raw: string;
    try {
      raw = await readFile(storageFilePath(scriptId), "utf8");
    } catch (error) {
      // 不存在 = 空存储；其他读失败（权限等）继续走显式失败路径。
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return {};
      throw error;
    }
    // 损坏文件显式失败（复核 m2-5）：JSON 解析失败与顶层形状非法都按损坏处理，
    // 静默当空会让脚本侧只看到「key 不存在」，等于丢数据。损坏文件由调用方
    // 原样保留、不覆盖（写路径只在读成功后到达），用户修复或删除后再恢复使用。
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      parsed = undefined;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      logger.warn(`[userscripts] storage for ${scriptId} is corrupt, failing explicitly`);
      throw new StorageCorruptError(scriptId);
    }
    return parsed as StoredPayload;
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

  /** 统一错误映射：损坏显式回 storage_corrupt，超限回 storage_limit，其余归 storage_error。 */
  function failureFrom(error: unknown): UserScriptStorageResult {
    if (error instanceof StorageCorruptError) return failure("storage_corrupt");
    if (error instanceof StorageLimitError) return failure("storage_limit");
    return failure("storage_error");
  }

  return {
    /** GM_getValue：key 缺失时返回 ok 且不带 value（调用方取默认值）。 */
    async getValue(scriptId: string, key: string): Promise<UserScriptStorageResult> {
      try {
        return await withLock(scriptId, async () => {
          const payload = await readPayload(scriptId);
          return key in payload ? { ok: true, value: payload[key] } : { ok: true };
        });
      } catch (error) {
        return failureFrom(error);
      }
    },

    /** GM_listValues：现存键列表（存储为空时为空数组）。 */
    async listValues(scriptId: string): Promise<UserScriptStorageResult> {
      try {
        return await withLock(scriptId, async () => {
          const payload = await readPayload(scriptId);
          return { ok: true, keys: Object.keys(payload) };
        });
      } catch (error) {
        return failureFrom(error);
      }
    },

    /** GM_setValue：并发写按 scriptId 串行化，size 超限拒绝。 */
    async setValue(
      scriptId: string,
      key: string,
      value: unknown,
    ): Promise<UserScriptStorageResult> {
      try {
        return await withLock(scriptId, async () => {
          const payload = await readPayload(scriptId);
          payload[key] = value;
          await writePayload(scriptId, payload);
          return { ok: true };
        });
      } catch (error) {
        return failureFrom(error);
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
      } catch (error) {
        return failureFrom(error);
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

    /**
     * 删除整个存储文件（P4 删除通道专用）：与 GM get/set 共用同一把 scriptId 锁，
     * 避免与并发存储读写交错。存在才删（返回 true）；不存在返回 false（幂等，
     * 「确认删存储」与「无存储」对调用方都算已完成）。调用方需先过 scriptId 校验；
     * 删除失败（权限等）原样上抛，由删除通道映射为显式失败码，不静默吞掉——
     * 用户已明确确认「删除数据」，静默残留等于丢承诺。
     */
    async deleteStorageFile(scriptId: string): Promise<boolean> {
      return await withLock(scriptId, async () => {
        const file = storageFilePath(scriptId);
        try {
          await stat(file);
        } catch {
          return false;
        }
        await rm(file, { force: true });
        return true;
      });
    },

    /**
     * 健康探测（P2 设置卡状态查询）：读取并校验存储文件形状。
     * 无文件 = ok（空存储）；损坏 = corrupt；其余读失败（权限等）按 ok 上报，
     * 避免把环境问题误报成数据损坏——真正写入时仍会显式失败。
     */
    async probeHealth(scriptId: string): Promise<"ok" | "corrupt"> {
      try {
        await withLock(scriptId, async () => {
          await readPayload(scriptId);
        });
        return "ok";
      } catch (error) {
        return error instanceof StorageCorruptError ? "corrupt" : "ok";
      }
    },
  };
}

export type UserscriptStorage = ReturnType<typeof createUserscriptStorage>;
