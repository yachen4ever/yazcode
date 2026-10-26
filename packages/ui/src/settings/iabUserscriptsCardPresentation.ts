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

export interface IabUserscriptViewRow {
  scriptId: string;
  name: string;
  version?: string;
  /** sha256 前 8 位 hex；未知时为 null（降级模式且 manifest 无锚）。 */
  shaShort: string | null;
  /** 开关选中态（enabled 语义）。 */
  switchChecked: boolean;
  /** 拒载行禁用开关。 */
  switchDisabled: boolean;
  /** 状态徽标（storage_corrupt 与脚本状态正交，可并存）。 */
  badges: IabUserscriptBadgeKind[];
  /** 待批准行显示「批准」主按钮。 */
  showApprove: boolean;
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
        switchChecked: enabledLike,
        switchDisabled: rejected,
        badges,
        showApprove: item.status === "pending_approval",
      };
    });
  }

  // 降级模式：manifest 派生行。不猜测 name / hash-mismatch / 拒载原因。
  return Object.entries(manifest).map(([scriptId, entry]) => {
    const pending = entry.pendingApproval === true;
    const enabled = entry.enabled === true;
    return {
      scriptId,
      name: scriptId,
      shaShort: toShaShort(entry.sha256),
      switchChecked: enabled,
      switchDisabled: false,
      badges: [enabled ? "enabled" : pending ? "pending_approval" : "disabled"],
      showApprove: pending,
    };
  });
}

/** 开关/批准动作产生的下一条 manifest 条目；返回 undefined 表示无变化（防御）。 */
export function nextManifestEntry(
  entry: IabUserscriptManifestLikeEntry | undefined,
  action: "approve" | "disable",
): IabUserscriptManifestLikeEntry | null {
  if (action === "approve") {
    // 用户批准 = P1 语义：enabled:true 且清 sha（下次扫描锚定当前内容）+ 清待批准标记。
    return { enabled: true };
  }
  if (!entry || entry.enabled !== false) {
    return { enabled: false };
  }
  return entry.pendingApproval === true ? { enabled: false } : null;
}
