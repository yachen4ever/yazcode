import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatSpeedLabels,
  shouldStartSessionDebugPolling,
} from "../src/v4/speedLabels.js";

const numberFormat = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });

describe("formatSpeedLabels", () => {
  it("有 prefill/decode 时返回两个标签", () => {
    const labels = formatSpeedLabels(
      { recordedAt: 1, tokensPerSecond: 88.6, prefillTokensPerSecond: 1200.4 },
      numberFormat,
    );
    assert.equal(labels.decodeLabel, "88.6");
    assert.equal(labels.prefillLabel, "1,200.4");
  });

  it("prefill 为 null（全缓存直出/TTFT=0）时只显示 decode", () => {
    const labels = formatSpeedLabels(
      { recordedAt: 1, tokensPerSecond: 88.6, prefillTokensPerSecond: null },
      numberFormat,
    );
    assert.equal(labels.decodeLabel, "88.6");
    assert.equal(labels.prefillLabel, null);
  });

  it("无匹配轮（undefined）时两个标签都为 null", () => {
    const labels = formatSpeedLabels(undefined, numberFormat);
    assert.equal(labels.decodeLabel, null);
    assert.equal(labels.prefillLabel, null);
  });
});

describe("shouldStartSessionDebugPolling", () => {
  it("sessionId 与 workspacePath 齐全才启动", () => {
    assert.equal(
      shouldStartSessionDebugPolling({ sessionId: "s", workspacePath: "/w" }),
      true,
    );
  });
  it("workspacePath 缺席（缺陷 ② 回归：调用点未传 props 时轮询恒不启动）", () => {
    assert.equal(shouldStartSessionDebugPolling({ sessionId: "s", workspacePath: undefined }), false);
  });
  it("sessionId 缺席不启动", () => {
    assert.equal(shouldStartSessionDebugPolling({ sessionId: null, workspacePath: "/w" }), false);
  });
});
