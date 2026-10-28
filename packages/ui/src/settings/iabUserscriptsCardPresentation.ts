import type { IabUserscriptStatusItem } from "@zcode/shared";

/**
 * IAB 用户脚本设置卡的纯展示投影（无 React 依赖，可直测）：
 * 把「平台状态查询（可能缺席）+ manifest」两路事实合并为统一的行视图。
 * 契约见 docs/specs/iab-userscripts.md P2：
 * - 开关语义：开 = 用户批准（patch {enabled:true}，下次扫描锚定）；关 = 禁用/驳回待批准；
 * - parse_failed / grant_rejected 行开关禁用（先修文件，批准无意义）；
 * - 无平台查询（普通 Web）时降级为 manifest 派生行，不猜测 name 与 hash-mismatch。
 */

export type IabUserscriptBadgeKind =
  | "serving"
  | "enabled"
  | "hash_mismatch"
  | "pending_approval"
  | "parse_failed"
  | "grant_rejected"
  | "storage_corrupt"
  | "disabled";

/** 徽标语义色（DESIGN.md 语义 token）：只在投影层映射，组件只查表。 */
export type IabUserscriptBadgeTone = "success" | "warning" | "destructive" | "neutral";

const BADGE_TONES: Record<IabUserscriptBadgeKind, IabUserscriptBadgeTone> = {
  serving: "success",
  pending_approval: "warning",
  hash_mismatch: "destructive",
  parse_failed: "destructive",
  grant_rejected: "destructive",
  storage_corrupt: "destructive",
  // 灰色只用于「无活动状态」：enabled 是待扫描的已批准态，disabled 是明确的停用。
  enabled: "neutral",
  disabled: "neutral",
};

export function badgeTone(kind: IabUserscriptBadgeKind): IabUserscriptBadgeTone {
  return BADGE_TONES[kind];
}

export interface IabUserscriptViewRow {
  scriptId: string;
  name: string;
  version?: string;
  /** sha256 前 8 位 hex；未知时为 null（降级模式且 manifest 无锚）。 */
  shaShort: string | null;
  /** 用户所见完整 sha256（live 为当前文件 hash，降级为 manifest 已锚 hash）；空串/缺失为 null。 */
  sha256: string | null;
  /** 开关选中态（enabled 语义）。 */
  switchChecked: boolean;
  /** 拒载行禁用开关。 */
  switchDisabled: boolean;
  /** 状态徽标（storage_corrupt 与脚本状态正交，可并存）。 */
  badges: IabUserscriptBadgeKind[];
  /** 待批准行显示「批准」主按钮。 */
  showApprove: boolean;
  /** 内容变更行显示「重新批准」按钮（与批准同一 patch 语义，见 P3 规则 4）。 */
  showReapprove: boolean;
  /** 由 @match 声明派生的域名列表（去 scheme/path、去重保序）；降级模式为空。 */
  matchDomains: string[];
  /** 拒载/失活原因原文；parse_failed 行是用户自查的唯一线索。 */
  detail: string | null;
  /** 最近一次实际注入时刻（epoch ms）；无记录为 null（「尚未注入」）。 */
  lastInjectedAt: number | null;
}

export interface IabUserscriptManifestLikeEntry {
  enabled: boolean;
  sha256?: string;
  pendingApproval?: boolean;
}

/** sha256 短码：前 8 位 hex 小写；空/超短输入返回 null（不展示截断噪音）。 */
export function toShaShort(sha256: string | undefined): string | null {
  if (typeof sha256 !== "string" || sha256.length < 8) return null;
  return sha256.slice(0, 8).toLowerCase();
}

/**
 * `@match` 声明 → 域名列表（去 scheme 与 path、去重保序）。
 * `<all_urls>` 原样保留；无法解析的条目原样保留——展示层不做 pattern 语义猜测，
 * 解析失败的 pattern 由状态徽标与 detail 表达，而不是在这里被吞掉。
 * 回包 pattern 编译期已拒绝带端口 host，因此无需（也不应）处理端口。
 */
export function toMatchDomains(match: string[]): string[] {
  const domains: string[] = [];
  const seen = new Set<string>();
  for (const pattern of match) {
    if (typeof pattern !== "string") continue;
    const trimmed = pattern.trim();
    if (!trimmed) continue;
    const domain = deriveMatchDomain(trimmed);
    if (seen.has(domain)) continue;
    seen.add(domain);
    domains.push(domain);
  }
  return domains;
}

function deriveMatchDomain(pattern: string): string {
  if (pattern === "<all_urls>") return pattern;
  const match = /^(?:https?|\*):\/\/([^/]+)/i.exec(pattern);
  // 没有可识别的 scheme://host 形状：原样保留，不猜。
  return match?.[1] ?? pattern;
}

/**
 * 卡片分区（P3 规则 3）：待批准行单独置顶，其余进 others。
 * 这是同一份状态列表的呈现派生，不是排序，也不引入第二份状态。
 */
export function partitionIabUserscriptRows(rows: IabUserscriptViewRow[]): {
  pending: IabUserscriptViewRow[];
  others: IabUserscriptViewRow[];
} {
  const pending: IabUserscriptViewRow[] = [];
  const others: IabUserscriptViewRow[] = [];
  for (const row of rows) {
    (row.badges.includes("pending_approval") ? pending : others).push(row);
  }
  return { pending, others };
}

/**
 * 合并两路事实：
 * - liveStatus 存在（桌面宿主）：行以扫描状态为准，manifest 仅补扫描外信息（无）；
 * - liveStatus 为 null（无宿主/查询失败）：行以 manifest 为准，badge 只有
 *   enabled/pending_approval/disabled，name 退化为 scriptId。
 */
export function buildIabUserscriptRows(input: {
  liveStatus: IabUserscriptStatusItem[] | null;
  manifest: Record<string, IabUserscriptManifestLikeEntry> | undefined;
}): IabUserscriptViewRow[] {
  const manifest = input.manifest ?? {};
  if (input.liveStatus) {
    return input.liveStatus.map((item) => {
      const rejected = item.status === "parse_failed" || item.status === "grant_rejected";
      const enabledLike = item.status === "serving" || item.status === "enabled_pending_anchor";
      // enabled_pending_anchor 在 UI 侧呈现为「已启用」（锚定是下一次扫描的内部动作）。
      const badges: IabUserscriptBadgeKind[] = [
        item.status === "enabled_pending_anchor" ? "enabled" : item.status,
      ];
      if (item.storageHealth === "corrupt") {
        badges.push("storage_corrupt");
      }
      return {
        scriptId: item.scriptId,
        name: item.name || item.scriptId,
        ...(item.version ? { version: item.version } : {}),
        shaShort: toShaShort(item.sha256),
        sha256: toSha256OrNull(item.sha256),
        switchChecked: enabledLike,
        switchDisabled: rejected,
        badges,
        showApprove: item.status === "pending_approval",
        showReapprove: item.status === "hash_mismatch",
        matchDomains: toMatchDomains(item.match),
        detail: toDetailOrNull(item.detail),
        lastInjectedAt: typeof item.lastInjectedAt === "number" ? item.lastInjectedAt : null,
      };
    });
  }

  // 降级模式：manifest 派生行。不猜测 name / hash-mismatch / 拒载原因 / 注入时刻。
  return Object.entries(manifest).map(([scriptId, entry]) => {
    const pending = entry.pendingApproval === true;
    const enabled = entry.enabled === true;
    return {
      scriptId,
      name: scriptId,
      shaShort: toShaShort(entry.sha256),
      sha256: toSha256OrNull(entry.sha256),
      switchChecked: enabled,
      switchDisabled: false,
      badges: [enabled ? "enabled" : pending ? "pending_approval" : "disabled"],
      showApprove: pending,
      showReapprove: false,
      matchDomains: [],
      detail: null,
      lastInjectedAt: null,
    };
  });
}

/** 空/非字符串 sha 归一为 null（读取失败的 "" 与缺省同义：无哈希可钉）。 */
function toSha256OrNull(sha256: string | undefined): string | null {
  return typeof sha256 === "string" && sha256.length > 0 ? sha256 : null;
}

/** 空白 detail 与缺省同义：不渲染空行。 */
function toDetailOrNull(detail: string | undefined): string | null {
  return typeof detail === "string" && detail.trim().length > 0 ? detail : null;
}

/**
 * 开关/批准动作产生的下一条 manifest 条目；返回 undefined 表示无变化（防御）。
 * M1（P2 复核）：approve 钉住用户所见 sha——批准即把当时展示的 liveStatus.sha256
 * 写回条目，关闭「批准 → 首扫锚定」窗口内 agent 改文件再 reload 使未确认内容
 * 被锚定的红线缺口；其后内容变更落 hash_mismatch 停服，而非被静默锚定执行。
 * seenSha256 为空（文件从未成功扫描/降级模式无锚）时回退 {enabled:true} 首扫锚定
 * ——「用户所见」无哈希可钉，该窗口固有（spec 已记录边界）。
 */
export function nextManifestEntry(
  entry: IabUserscriptManifestLikeEntry | undefined,
  action: "approve" | "disable",
  seenSha256?: string | null,
): IabUserscriptManifestLikeEntry | null {
  if (action === "approve") {
    // 用户批准 = approve-once-per-content：enabled:true + 钉住所见内容指纹 +
    // 清待批准标记（整条目替换）。
    return seenSha256 ? { enabled: true, sha256: seenSha256 } : { enabled: true };
  }
  if (!entry || entry.enabled !== false) {
    return { enabled: false };
  }
  return entry.pendingApproval === true ? { enabled: false } : null;
}
