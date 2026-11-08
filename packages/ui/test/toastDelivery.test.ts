import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createToastDelivery } from "../src/components/ui/toastDelivery.js";

/**
 * toast 投递零 rAF 契约（26.5.6 修复项 1/2）：
 * 被遮挡/后台的 Electron 窗口 rAF 停摆时，旧实现（rAF 重试投递 + rAF 翻转可见性）
 * 让 toast 延迟数秒或永久丢失——26.5.4/26.5.5 两轮双盲「刷新失败 toast 全程未出现」
 * 的根因。修复后投递只能走「立即送达或缓冲待挂载排空」，不得再有 rAF 参与。
 */

describe("createToastDelivery 投递契约", () => {
  it("接收方就绪时同步送达", () => {
    const delivery = createToastDelivery<string>();
    const received: string[] = [];
    delivery.setReceiver((item) => received.push(item));
    delivery.deliver("a");
    assert.deepEqual(received, ["a"]);
  });

  it("接收方缺席时缓冲，挂载后排空且保持入队顺序（无 rAF 参与）", () => {
    const delivery = createToastDelivery<string>();
    delivery.deliver("a");
    delivery.deliver("b");
    assert.deepEqual(delivery.buffered(), ["a", "b"]);
    const received: string[] = [];
    delivery.setReceiver((item) => received.push(item));
    assert.deepEqual(received, ["a", "b"]);
    assert.deepEqual(delivery.buffered(), []);
  });

  it("排空后新投递立即送达", () => {
    const delivery = createToastDelivery<string>();
    const received: string[] = [];
    delivery.deliver("early");
    delivery.setReceiver((item) => received.push(item));
    delivery.deliver("late");
    assert.deepEqual(received, ["early", "late"]);
  });

  it("卸载接收方后回到缓冲语义", () => {
    const delivery = createToastDelivery<string>();
    const received: string[] = [];
    delivery.setReceiver((item) => received.push(item));
    delivery.unsetReceiver();
    delivery.deliver("queued");
    assert.deepEqual(received, []);
    assert.deepEqual(delivery.buffered(), ["queued"]);
  });
});

describe("toast 模块源级零 rAF 断言", () => {
  it("toast.tsx 不再出现 requestAnimationFrame（26.5.6 根因回归守卫）", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/components/ui/toast.tsx", import.meta.url)),
      "utf8",
    );
    assert.equal(
      source.includes("requestAnimationFrame"),
      false,
      "toast 模块必须保持零 rAF 依赖：投递与可见性在任何窗口可见性状态下都不得依赖帧产出",
    );
  });
});
