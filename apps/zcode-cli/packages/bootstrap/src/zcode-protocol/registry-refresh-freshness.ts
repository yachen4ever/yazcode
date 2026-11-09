/**
 * Registry 刷新新鲜度凭据（26.5.9 修复批，spec probe-registry-refresh-dedup.md）。
 *
 * 26.5.8 的探测去重假设「host 推送 account config 的 refresh 已覆盖探测所需数据」——
 * 该假设在 Base URL（personal config 侧）维度不成立：推送路径的 refresh 可能发生在
 * personal 文件落盘之前，跳过探测侧 refresh 会读到旧 Base URL（#29 八轮实测退化）。
 *
 * 修正语义：去重必须「自证刷新覆盖」——只有「最近一次 registry refresh 完成之后
 * config 源（builtin+personal）没有再变化」时才允许探测跳过自身刷新。
 *
 * 实现（零额外 IO）：
 * - configEpoch：config 源 onDidChange 每次触发 +1（personal/builtin 任一变化）；
 * - refreshEpoch：最近一次 registry refresh 完成时刻的 configEpoch 快照；
 * - isCurrent()：refreshEpoch === configEpoch；
 * - 任何无法自证的状态（从未刷新/epoch 缺失）都返回 false → 调用方照旧刷新
 *   （fail-open 落在「多刷新一次」的安全侧）。
 */

export interface RegistryRefreshFreshness {
  /** config 源（builtin+personal）发生变化：此前完成的 refresh 不再覆盖最新数据。 */
  noteConfigChange(): void;
  /** 一次 registry refresh 已完成：把当前 configEpoch 记为已覆盖。 */
  markRefreshCurrent(): void;
  /** 最近一次 refresh 是否已覆盖当前 config 源状态。 */
  isCurrent(): boolean;
}

export function createRegistryRefreshFreshness(): RegistryRefreshFreshness {
  let configEpoch = 0;
  // 初始为 -1：从未刷新时永不「新鲜」，调用方必须自行刷新。
  let refreshEpoch = -1;
  return {
    noteConfigChange() {
      configEpoch += 1;
    },
    markRefreshCurrent() {
      refreshEpoch = configEpoch;
    },
    isCurrent() {
      return refreshEpoch === configEpoch;
    },
  };
}
