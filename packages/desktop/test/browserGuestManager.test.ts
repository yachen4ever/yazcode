import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isLateRendererTabReport } from "../src/main/browserView/rendererTabAdmission.js";

/**
 * reportResidency 迟到上报防护（ZCodium #66 同型）：面板关闭 / 切 tab 后 renderer
 * 在途上报到达时，tab 可能已删除或标记 closed——迟到上报必须静默丢弃（不能让 IPC
 * handler 的 throw 进 main process 错误日志）。browserGuestManager 顶层 import
 * electron 无法在 node:test 加载，判定语义抽在 electron-free 的
 * rendererTabAdmission 并在此锚定；作用域不匹配不归本判定管（manager 侧仍严格抛错）。
 */

describe("isLateRendererTabReport 迟到上报判定", () => {
  it("tab 已标记 closed 的在途上报判定为迟到", () => {
    assert.equal(isLateRendererTabReport({ tabId: "t", lifecycle: "closed" }), true);
  });

  it("tab 已删除（undefined）判定为迟到", () => {
    assert.equal(isLateRendererTabReport(undefined), true);
  });

  it("存活中的 tab（active / deliverable / handoff）不判迟到——继续走严格作用域校验", () => {
    for (const lifecycle of ["active", "deliverable", "handoff"] as const) {
      assert.equal(isLateRendererTabReport({ tabId: "t", lifecycle }), false);
    }
  });
});
