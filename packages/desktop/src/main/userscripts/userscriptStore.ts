import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { buildUserScriptDef, type UserScriptDef } from "./userscriptRules.js";

/**
 * manifest 端口：生产实现包 SettingService（AppSettings.embeddedBrowserUserscripts），
 * 测试注入内存实现。store 自己不落盘，保证设置存储是 manifest 的唯一所有者。
 */
export interface UserscriptManifestPort {
  getManifest(): Promise<Record<string, { enabled: boolean; sha256?: string }>>;
  saveManifest(manifest: Record<string, { enabled: boolean; sha256?: string }>): Promise<void>;
}

export type UserScriptScanFindingStatus =
  | "disabled"
  | "parse_failed"
  | "grant_rejected"
  | "hash_mismatch"
  | "anchored";

export interface UserScriptScanFinding {
  scriptId: string;
  status: UserScriptScanFindingStatus;
  detail?: string;
}

export interface UserScriptScanResult {
  /** enabled ∧ sha256 一致 ∧ 头解析与 grant 校验通过的脚本（服务集）。 */
  serveable: UserScriptDef[];
  findings: UserScriptScanFinding[];
}

export interface UserscriptStoreOptions {
  scriptsDir: string;
  manifestPort: UserscriptManifestPort;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
}

const USER_SCRIPT_SUFFIX = ".user.js";

export function computeScriptSha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * 用户脚本 store：每次请求全量重扫脚本目录（目录规模为个位数文件、KB 级），
 * 重扫同时天然完成「enabled ∧ sha256 一致」复核，不维护扫描缓存——
 * 缓存会引入第二个状态所有者，且让内容变更的失效出现延迟。
 *
 * 锚定语义（docs/specs/iab-userscripts.md 行为规则 2）：条目 enabled 且缺 sha256
 * 时，扫描把当前文件 hash 写回 manifest（一次性批准锚定）；此后文件内容变更即
 * hash 不一致 → 停止服务并记录，重新批准 = 显式把条目改回 enabled 无 sha。
 */
export function createUserscriptStore(options: UserscriptStoreOptions) {
  const { scriptsDir, manifestPort, logger } = options;

  async function scan(): Promise<UserScriptScanResult> {
    const serveable: UserScriptDef[] = [];
    const findings: UserScriptScanFinding[] = [];

    let entries: Dirent[];
    try {
      entries = await readdir(scriptsDir, { withFileTypes: true });
    } catch (error) {
      // 目录不存在 = 功能未使用（不是错误）；其他读取异常按空目录降级并记录。
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        logger.warn(`[userscripts] scan scripts dir failed: ${String(error)}`);
      }
      return { serveable, findings };
    }

    const manifest = await manifestPort.getManifest();
    const anchors = new Map<string, string>();

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(USER_SCRIPT_SUFFIX)) continue;
      const scriptId = entry.name.slice(0, -USER_SCRIPT_SUFFIX.length);
      if (!scriptId) continue;

      let content: Buffer;
      try {
        content = await readFile(join(scriptsDir, entry.name));
      } catch (error) {
        logger.warn(`[userscripts] read ${scriptId} failed: ${String(error)}`);
        findings.push({ scriptId, status: "parse_failed", detail: "read failed" });
        continue;
      }
      const sha256 = computeScriptSha256(content);
      const parsed = buildUserScriptDef({
        scriptId,
        code: content.toString("utf8"),
        sha256,
        fallbackName: scriptId,
      });
      if (!parsed.ok) {
        const status = parsed.reason.startsWith("grant not allowed") ? "grant_rejected" : "parse_failed";
        logger.warn(`[userscripts] reject ${scriptId}: ${parsed.reason}`);
        findings.push({ scriptId, status, detail: parsed.reason });
        continue;
      }

      const manifestEntry = manifest[scriptId];
      if (!manifestEntry || manifestEntry.enabled !== true) {
        // 发现 ≠ 启用：新文件或显式禁用的脚本不注入。
        findings.push({ scriptId, status: "disabled" });
        continue;
      }
      if (!manifestEntry.sha256) {
        // 待锚定：本次扫描把当前 hash 写回 manifest，随后开始服务。
        anchors.set(scriptId, sha256);
        findings.push({ scriptId, status: "anchored" });
      } else if (manifestEntry.sha256 !== sha256) {
        logger.warn(
          `[userscripts] ${scriptId} content changed since approval (sha256 mismatch), staying inert`,
        );
        findings.push({ scriptId, status: "hash_mismatch" });
        continue;
      }
      serveable.push(parsed.def);
    }

    if (anchors.size > 0) {
      try {
        const merged = { ...manifest };
        for (const [scriptId, sha256] of anchors) {
          merged[scriptId] = { ...(merged[scriptId] ?? { enabled: true }), enabled: true, sha256 };
        }
        await manifestPort.saveManifest(merged);
        logger.info(
          `[userscripts] anchored ${anchors.size} script(s): ${[...anchors.keys()].join(", ")}`,
        );
      } catch (error) {
        // 锚定写失败不阻断本次服务（批准动作已由用户显式做出）；下次扫描重试锚定。
        logger.warn(`[userscripts] anchor manifest save failed: ${String(error)}`);
      }
    }

    return { serveable, findings };
  }

  return { scan };
}

export type UserscriptStore = ReturnType<typeof createUserscriptStore>;
