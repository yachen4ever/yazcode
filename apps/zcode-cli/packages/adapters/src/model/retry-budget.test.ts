import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ModelRetryBudget } from "@zcode/contracts";
import {
  isUnboundedRetryBudget,
  retryAttemptLoopContinues,
  retryBudgetAllows,
  retryBudgetMaxAttempts,
} from "./retry-budget.js";

/** 重试预算档位判定（26.5.7 前置调查 issue #12：新增 single 档）。 */

describe("retry-budget 档位判定", () => {
  it("default：既有语义不变（循环与再试按 maxAttempts）", () => {
    assert.equal(retryAttemptLoopContinues(ModelRetryBudget.Default, 5, 11), true);
    assert.equal(retryAttemptLoopContinues(ModelRetryBudget.Default, 12, 11), false);
    assert.equal(retryBudgetAllows(ModelRetryBudget.Default, 5, 11), true);
    assert.equal(retryBudgetAllows(ModelRetryBudget.Default, 11, 11), false);
    assert.equal(retryBudgetMaxAttempts(ModelRetryBudget.Default, 11), 11);
  });

  it("unbounded：恒真循环 + 哨兵 0", () => {
    assert.equal(retryAttemptLoopContinues(ModelRetryBudget.Unbounded, 999, 11), true);
    assert.equal(retryBudgetAllows(ModelRetryBudget.Unbounded, 999, 11), true);
    assert.equal(retryBudgetMaxAttempts(ModelRetryBudget.Unbounded, 11), 0);
  });

  it("single：总尝试数 1，任何失败后不允许再试", () => {
    assert.equal(retryAttemptLoopContinues(ModelRetryBudget.Single, 1, 11), true);
    assert.equal(retryAttemptLoopContinues(ModelRetryBudget.Single, 2, 11), false);
    assert.equal(retryBudgetAllows(ModelRetryBudget.Single, 1, 11), false);
    assert.equal(retryBudgetMaxAttempts(ModelRetryBudget.Single, 11), 1);
  });

  it("缺省（无预算）：与 default 同口径", () => {
    assert.equal(retryAttemptLoopContinues(undefined, 5, 11), true);
    assert.equal(retryBudgetAllows(undefined, 11, 11), false);
    assert.equal(retryBudgetMaxAttempts(undefined, 11), 11);
  });

  it("陈旧 dist 场景：枚举键退化为 undefined 时，缺省调用不得被误判（26.5.8 ①）", () => {
    // 26.5.7 验收实测路径：本地 contracts dist 陈旧时枚举键可能解析为 undefined——
    // 旧实现 `budget === ModelRetryBudget.X` 在 X===undefined 且 budget===undefined
    // 时恒真，把缺省预算无声反转成 single/unbounded。守卫加固后 undefined 预算恒走
    // default 口径（fail-open）：任一档位语义都不被缺省调用意外触发。
    assert.equal(isUnboundedRetryBudget(undefined), false);
    // single 无独立导出，经闸门验证：undefined 预算下失败后仍允许重试（非 single）。
    assert.equal(retryBudgetAllows(undefined, 1, 11), true);
    assert.equal(retryAttemptLoopContinues(undefined, 2, 11), true);
    assert.equal(retryAttemptLoopContinues(undefined, 12, 11), false);
    assert.equal(retryBudgetMaxAttempts(undefined, 11), 11);
    // 陈旧 dist 的等价性说明：调用方按 ModelRetryBudget.Single 传入的预算值在缺键
    // 时退化为 undefined，与「未指定预算」不可区分——因此本组 undefined 断言即为
    // 陈旧 dist 场景的回归断言（守卫只认在册档位字面量，undefined 永不命中）。
  });
});
