import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldHideWindowToTray } from "../src/main/desktopTrayGate.js";

// Windows 关闭到托盘的托盘就绪门禁真值表
// （spec：packages/desktop/specs/desktop-tray-close-gate.md 验收场景 1-3）。
const base = {
  platform: "win32" as const,
  closeToTrayOnWindows: true,
  closeToTraySupported: true,
  forceQuit: false,
};

describe("desktopTrayGate.shouldHideWindowToTray", () => {
  it("win32 + 设置开 + 托盘就绪 + 非 forceQuit/显式退出 → 隐藏（现状不变）", () => {
    assert.equal(shouldHideWindowToTray({ ...base }), true);
    assert.equal(shouldHideWindowToTray({ ...base, explicitQuitRequested: false }), true);
  });

  it("托盘未就绪（创建失败）→ 不隐藏，走正常关闭流（本门禁新增）", () => {
    assert.equal(shouldHideWindowToTray({ ...base, closeToTraySupported: false }), false);
  });

  it("forceQuit / 显式退出 / 设置关 / 非 win32 → 均不隐藏（现状不变）", () => {
    assert.equal(shouldHideWindowToTray({ ...base, forceQuit: true }), false);
    assert.equal(shouldHideWindowToTray({ ...base, explicitQuitRequested: true }), false);
    assert.equal(shouldHideWindowToTray({ ...base, closeToTrayOnWindows: false }), false);
    assert.equal(shouldHideWindowToTray({ ...base, platform: "darwin" }), false);
    assert.equal(shouldHideWindowToTray({ ...base, platform: "linux" }), false);
  });
});
