import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ModelRetryBudget } from "@zcode/contracts";
import {
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
});
