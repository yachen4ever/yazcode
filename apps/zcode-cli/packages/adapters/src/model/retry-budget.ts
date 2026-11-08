import { ModelRetryBudget } from "@zcode/contracts";

/**
 * 重试预算档位的判定。
 *
 * 「无上限」**只**放宽瞬态失败的放弃条件：runner 的 attempt 循环、失败后「还能不能再试」两处闸门；
 * 退避曲线（2s→60s、jitter、Retry-After 优先）、`isRetryableFailure` 的分类、
 * `emittedRetryBoundaryEvent` 之后不重试、空补全重试与 compact 路径一律不动。
 * 「单次」（single）则**收紧**全部闸门：总尝试数 1，任何失败都立即返回（探测类调用，
 * 调用方自带失败处理——见 workspace-generate-text 的 testModelConnectivity）。
 */

/** 状态事件里 `maxAttempts` 表示「无上限」的哨兵（Infinity 不可序列化，0 不占用合法计数）。 */
export const UNBOUNDED_RETRY_MAX_ATTEMPTS = 0;

export function isUnboundedRetryBudget(budget: ModelRetryBudget | undefined): boolean {
  // undefined 防御（26.5.8 ①）：陈旧 dist / 半新半旧依赖图下 `ModelRetryBudget.Unbounded`
  // 可能解析为 undefined，`budget === undefined` 会把**缺省预算**误判成 unbounded——
  // 所有调用静默放开重试（语义反转且无声）。先排除 undefined，缺省永不误判。
  if (budget === undefined) return false;
  return budget === ModelRetryBudget.Unbounded;
}

function isSingleAttemptBudget(budget: ModelRetryBudget | undefined): boolean {
  // undefined 防御（26.5.8 ①，同上）：陈旧 dist 下 `ModelRetryBudget.Single` 解析为
  // undefined 时，`undefined === undefined` 会把**缺省预算**误判成 single——所有未指定
  // 预算的调用静默变成单次尝试。缺省预算 fail-open 到 default 侧（26.5.7 验收实测踩过
  // 该路径：本地陈旧 dist 使例句语境翻转）。
  if (budget === undefined) return false;
  return budget === ModelRetryBudget.Single;
}

/** 失败之后还允许再试一次吗（等价于既有的 `retryBudgetAttempt < maxAttempts`，unbounded 恒真）。 */
export function retryBudgetAllows(
  budget: ModelRetryBudget | undefined,
  retryBudgetAttempt: number,
  maxAttempts: number,
): boolean {
  if (isSingleAttemptBudget(budget)) return false;
  return isUnboundedRetryBudget(budget) || retryBudgetAttempt < maxAttempts;
}

/** attempt 循环的继续条件（等价于既有的 `attempt <= loopMaxAttempts`，unbounded 恒真）。 */
export function retryAttemptLoopContinues(
  budget: ModelRetryBudget | undefined,
  attempt: number,
  loopMaxAttempts: number,
): boolean {
  if (isSingleAttemptBudget(budget)) return attempt <= 1;
  return isUnboundedRetryBudget(budget) || attempt <= loopMaxAttempts;
}

/** 写进状态事件 / 日志的 maxAttempts：unbounded 下是哨兵 0，single 下固定 1。 */
export function retryBudgetMaxAttempts(
  budget: ModelRetryBudget | undefined,
  maxAttempts: number,
): number {
  if (isSingleAttemptBudget(budget)) return 1;
  return isUnboundedRetryBudget(budget) ? UNBOUNDED_RETRY_MAX_ATTEMPTS : maxAttempts;
}
