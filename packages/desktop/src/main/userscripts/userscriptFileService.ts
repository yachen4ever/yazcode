import type {
  IabUserscriptDeleteResult,
  IabUserscriptFetchSourceResult,
  IabUserscriptReadResult,
  IabUserscriptWriteResult,
} from "@zcode/shared";
import { createUserscriptFiles, type UserscriptFilesLogger } from "./userscriptFiles.js";
import { createUserscriptStorage, type UserscriptStorage } from "./userscriptStorage.js";
import { fetchUserscriptSource, type FetchUserscriptSourceDeps } from "./userscriptUrlInstall.js";

/**
 * P4 宿主文件能力的服务层（renderer → main，electron-free 可直测）：
 * read / write / delete / fetchSource 四个通道的入参形状校验与组装。
 * 与 userscriptService（guest 面 + agent 命令面）分离：这是 renderer 宿主面，
 * 不做 IAB 分区与主 frame 校验，也刻意不提供任何「批准」语义——manifest 一概
 * 不在这里写，落盘 ≠ 批准（P4 红线 1/2）。
 */

export interface CreateUserscriptFileServiceOptions {
  scriptsDir: string;
  storageRootDir: string;
  logger: UserscriptFilesLogger;
  /**
   * 注入与 userscriptService 共用的 storage 实例（bootstrap 只建一份）。
   * 缺省时自建——仅限测试/独立使用；生产装配必须注入，否则 GM 存储的
   * per-scriptId 锁表出现两份，guest 写入与删除通道的存储删除不再互斥。
   */
  storage?: UserscriptStorage;
  /** URL 拉取的测试注入（fetch/lookup）；生产走缺省 undici 实现。 */
  urlFetchDeps?: FetchUserscriptSourceDeps;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function createUserscriptFileService(options: CreateUserscriptFileServiceOptions) {
  const storage =
    options.storage ??
    createUserscriptStorage({
      rootDir: options.storageRootDir,
      logger: options.logger,
    });
  const files = createUserscriptFiles({
    scriptsDir: options.scriptsDir,
    storage,
    logger: options.logger,
  });

  return {
    /** IabUserscriptsRead：编辑前读当前文件内容。 */
    async readScript(payload: unknown): Promise<IabUserscriptReadResult> {
      if (!isPlainRecord(payload) || typeof payload.scriptId !== "string") {
        return { ok: false, error: "invalid_script_id" };
      }
      return files.readScript(payload.scriptId);
    },

    /** IabUserscriptsWrite：新建/导入/编辑保存共用；overwrite 语义见 userscriptFiles。 */
    async writeScript(payload: unknown): Promise<IabUserscriptWriteResult> {
      if (!isPlainRecord(payload) || typeof payload.scriptId !== "string") {
        return { ok: false, error: "invalid_script_id" };
      }
      if (typeof payload.content !== "string") {
        return { ok: false, error: "invalid_content" };
      }
      if (typeof payload.overwrite !== "boolean") {
        // 重名覆盖必须是显式布尔（P4 红线 5）：缺省/非布尔一律按不覆盖处理。
        return { ok: false, error: "exists" };
      }
      return files.writeScript(payload.scriptId, payload.content, payload.overwrite);
    },

    /** IabUserscriptsDelete：删脚本文件；deleteStorage=false 时保留 GM 存储。 */
    async deleteScript(payload: unknown): Promise<IabUserscriptDeleteResult> {
      if (!isPlainRecord(payload) || typeof payload.scriptId !== "string") {
        return { ok: false, error: "invalid_script_id" };
      }
      if (typeof payload.deleteStorage !== "boolean") {
        return { ok: false, error: "invalid_script_id" };
      }
      return files.deleteScript(payload.scriptId, payload.deleteStorage);
    },

    /** IabUserscriptsFetchSource：段 1 拉取 + 静态预览，不落盘。 */
    async fetchSource(payload: unknown): Promise<IabUserscriptFetchSourceResult> {
      if (!isPlainRecord(payload) || typeof payload.url !== "string") {
        return { ok: false, error: "invalid_url" };
      }
      return fetchUserscriptSource(payload.url, options.urlFetchDeps);
    },
  };
}

export type UserscriptFileService = ReturnType<typeof createUserscriptFileService>;
