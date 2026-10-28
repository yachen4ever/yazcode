import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { buildUserScriptDef, type UserScriptDef, type UserScriptRunAt } from "./userscriptRules.js";

/**
 * manifest 端口：生产实现包 SettingService（AppSettings.embeddedBrowserUserscripts），
 * 测试注入内存实现。store 自己不落盘，保证设置存储是 manifest 的唯一所有者。
 * pendingApproval（P2 确认流）：agent 请求启用的待批准标记，恒伴随 enabled=false，
 * 服务集判定只看 enabled，不依赖该字段。
 */
export interface UserscriptManifestEntry {
  enabled: boolean;
  sha256?: string;
  pendingApproval?: boolean;
}

export interface UserscriptManifestPort {
  getManifest(): Promise<Record<string, UserscriptManifestEntry>>;
  saveManifest(manifest: Record<string, UserscriptManifestEntry>): Promise<void>;
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

/**
 * P2 状态词汇（userscript_list / 设置卡状态查询共用），契约见 docs/specs/iab-userscripts.md。
 * 优先级：静态拒载（parse_failed/grant_rejected）> manifest 状态。
 */
export type UserScriptStatusValue =
  | "serving"
  | "enabled_pending_anchor"
  | "hash_mismatch"
  | "disabled"
  | "pending_approval"
  | "parse_failed"
  | "grant_rejected";

/** 只读状态投影的单条记录：不含脚本代码与文件路径。 */
export interface UserScriptStatusItem {
  scriptId: string;
  name: string;
  version?: string;
  runAt: UserScriptRunAt;
  grants: string[];
  match: string[];
  status: UserScriptStatusValue;
  /** 当前文件内容 sha256（hex）。 */
  sha256: string;
  detail?: string;
  /**
   * 最近一次实际注入（match 回包）的 epoch 毫秒。
   * 运行时事实：归属 main userscriptService 内存表，不在 store 与 manifest 中；
   * 进程重启清零，且无记录时字段缺席（不写 null/0，避免伪造「1970 年注入」）。
   * 记录点是回包而非执行完成：document-end/idle 脚本该值早于实际执行。
   */
  lastInjectedAt?: number;
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

/** 单文件评估结果：hash + parse 结果（parse 失败带原因），scan 与 inspect 共用。 */
interface UserScriptFileEvaluation {
  scriptId: string;
  sha256: string;
  def: UserScriptDef | null;
  rejectReason: string | null;
}

/**
 * 用户脚本 store：每次请求全量重扫脚本目录（目录规模为个位数文件、KB 级），
 * 重扫同时天然完成「enabled ∧ sha256 一致」复核，不维护扫描缓存——
 * 缓存会引入第二个状态所有者，且让内容变更的失效出现延迟。
 *
 * 锚定语义（docs/specs/iab-userscripts.md 行为规则 2）：条目 enabled 且缺 sha256
 * 时，扫描把当前文件 hash 写回 manifest（一次性批准锚定）；此后文件内容变更即
 * hash 不一致 → 停止服务并记录，重新批准 = 显式把条目改回 enabled 无 sha。
 * P2 的 inspect() 是只读状态投影，不做锚定写（锚定仍只发生在 scan 路径），
 * 避免「查询状态」成为隐藏的批准动作。
 */
export function createUserscriptStore(options: UserscriptStoreOptions) {
  const { scriptsDir, manifestPort, logger } = options;

  async function listEvaluations(): Promise<UserScriptFileEvaluation[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(scriptsDir, { withFileTypes: true });
    } catch (error) {
      // 目录不存在 = 功能未使用（不是错误）；其他读取异常按空目录降级并记录。
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        logger.warn(`[userscripts] scan scripts dir failed: ${String(error)}`);
      }
      return [];
    }

    const evaluations: UserScriptFileEvaluation[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(USER_SCRIPT_SUFFIX)) continue;
      const scriptId = entry.name.slice(0, -USER_SCRIPT_SUFFIX.length);
      if (!scriptId) continue;

      let content: Buffer;
      try {
        content = await readFile(join(scriptsDir, entry.name));
      } catch (error) {
        logger.warn(`[userscripts] read ${scriptId} failed: ${String(error)}`);
        evaluations.push({
          scriptId,
          sha256: "",
          def: null,
          rejectReason: "read failed",
        });
        continue;
      }
      const sha256 = computeScriptSha256(content);
      const parsed = buildUserScriptDef({
        scriptId,
        code: content.toString("utf8"),
        sha256,
        fallbackName: scriptId,
      });
      evaluations.push(
        parsed.ok
          ? { scriptId, sha256, def: parsed.def, rejectReason: null }
          : { scriptId, sha256, def: null, rejectReason: parsed.reason },
      );
    }
    return evaluations;
  }

  async function scan(): Promise<UserScriptScanResult> {
    const serveable: UserScriptDef[] = [];
    const findings: UserScriptScanFinding[] = [];
    const [evaluations, manifest] = await Promise.all([
      listEvaluations(),
      manifestPort.getManifest(),
    ]);
    const anchors = new Map<string, string>();

    for (const { scriptId, sha256, def, rejectReason } of evaluations) {
      if (!def || rejectReason) {
        const status = rejectReason?.startsWith("grant not allowed")
          ? "grant_rejected"
          : "parse_failed";
        logger.warn(`[userscripts] reject ${scriptId}: ${rejectReason}`);
        findings.push({ scriptId, status, detail: rejectReason });
        continue;
      }

      const manifestEntry = manifest[scriptId];
      if (!manifestEntry || manifestEntry.enabled !== true) {
        // 发现 ≠ 启用：新文件、显式禁用或待批准（pendingApproval 恒 enabled=false）的脚本不注入。
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
      serveable.push(def);
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

  /** 只读状态投影（P2）：重导出目录 + manifest 事实，不产生任何 manifest 写。 */
  async function inspect(): Promise<UserScriptStatusItem[]> {
    const [evaluations, manifest] = await Promise.all([
      listEvaluations(),
      manifestPort.getManifest(),
    ]);
    return evaluations.map((evaluation) => toStatusItem(evaluation, manifest[evaluation.scriptId]));
  }

  return { scan, inspect };
}

/** 单文件评估 + manifest 条目 → 状态记录；静态拒载优先于 manifest 状态。 */
export function toStatusItem(
  evaluation: UserScriptFileEvaluation,
  entry: UserscriptManifestEntry | undefined,
): UserScriptStatusItem {
  const { scriptId, sha256 } = evaluation;
  if (!evaluation.def) {
    const reason = evaluation.rejectReason ?? "parse failed";
    return {
      scriptId,
      name: scriptId,
      runAt: "document-start",
      grants: [],
      match: [],
      status: reason.startsWith("grant not allowed") ? "grant_rejected" : "parse_failed",
      sha256,
      detail: reason,
    };
  }
  const def = evaluation.def;
  let status: UserScriptStatusValue;
  if (!entry || entry.enabled !== true) {
    status = entry?.pendingApproval === true ? "pending_approval" : "disabled";
  } else if (!entry.sha256) {
    status = "enabled_pending_anchor";
  } else if (entry.sha256 !== sha256) {
    status = "hash_mismatch";
  } else {
    status = "serving";
  }
  return {
    scriptId,
    name: def.name,
    ...(def.version ? { version: def.version } : {}),
    runAt: def.runAt,
    grants: def.grants,
    match: def.matchPatterns,
    status,
    sha256,
  };
}

export type UserscriptStore = ReturnType<typeof createUserscriptStore>;
