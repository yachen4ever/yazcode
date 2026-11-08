import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

// macOS DMG 布局契约：背景图上的说明文字、应用图标、Applications 链接和两个
// 解除拦截说明文件必须保持固定相对位置。上游 ZCodium 的 dmg.contents 曾被其上游
// 同步（de5923d1）整体覆盖，图标坐标退回 electron-builder 默认值并删掉说明文件，
// 导致 1.17.0 的 DMG 文字被图标遮挡、说明文件缺失。本测试自上游 aa73b617 移植
// （vitest 改写为 node:test + assert），断言值全部改用本仓事实源，防止同类回退。
//
// 本仓 config 顶层会加载 Built-in Provider 配置（构建期副作用）：CLI 宿主会向
// 子进程注入 ZCODE_ENV 与 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 指向宿主 runtime
// 数据，其 schema 可能比仓库新，直接导入会因 ZodError 失败。导入前必须强制改指
// 仓库内配置源并切 test 环境；dmg 块是静态字面量，与这两个变量无关，被测对象不变。
process.env.ZCODE_ENV = "test";
process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = fileURLToPath(
  new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
);
const { default: desktopBuilderConfig } = await import("../electron-builder.config.js");

const desktopPackageRoot = fileURLToPath(new URL("..", import.meta.url));

interface DmgContent {
  x?: number;
  y?: number;
  type?: string;
  path?: string;
}

interface PngSize {
  width: number;
  height: number;
}

const dmg = desktopBuilderConfig.dmg as
  | {
      size?: string;
      icon?: string;
      background?: string;
      contents?: DmgContent[];
    }
  | undefined;

const backgroundPath = join(desktopPackageRoot, dmg?.background ?? "");
const retinaBackgroundPath = backgroundPath.replace(/\.png$/i, "@2x.png");
const contents = dmg?.contents ?? [];
const visibleContents = contents.filter((item) => !item.path?.startsWith("."));
const appEntry = visibleContents.find((item) => item.type == null);
const applicationsEntry = visibleContents.find((item) => item.type === "link");
const guideEntries = visibleContents.filter((item) => item.type === "file");

function readPngSize(filePath: string): PngSize {
  const png = readFileSync(filePath);
  // PNG 签名 8 字节 + IHDR 长度/类型 8 字节后是宽高（大端 uint32）。
  assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe("macOS DMG 安装布局", () => {
  it("背景图事实源为 620x560，@2x 为 2 倍尺寸", () => {
    assert.equal(dmg?.background, "build/dmg_background.png");
    assert.ok(existsSync(backgroundPath));
    assert.ok(existsSync(retinaBackgroundPath));

    assert.deepEqual(readPngSize(backgroundPath), { width: 620, height: 560 });
    assert.deepEqual(readPngSize(retinaBackgroundPath), { width: 1240, height: 1120 });
  });

  it("DMG 容量与安装盘图标为本仓显式值，不回退默认（顺带补锁：上游测试未覆盖）", () => {
    // 依赖自动容量时挂载卷只有约 1.9Gi，复制 .app 会因空间耗尽丢失 Electron
    // Framework 主二进制，安装后启动直接报 DYLD Library missing。
    assert.equal(dmg?.size, "3200m");
    // 安装盘图标统一使用安装专用素材，避免复用应用图标导致安装识别度不足。
    assert.ok(existsSync(join(desktopPackageRoot, dmg?.icon ?? "")));
  });

  it("应用图标与 Applications 链接位于说明文字上方，不回退到默认坐标", () => {
    // 背景从 y≈190 起绘制安装说明文字；图标中心必须在上方，否则会盖住文字。
    assert.deepEqual(appEntry, { x: 150, y: 120 });
    assert.deepEqual(applicationsEntry, { x: 470, y: 120, type: "link", path: "/Applications" });

    // electron-builder 的默认布局正好落在背景文字上，显式禁止再次出现。
    assert.equal(
      contents.some((item) => item.x === 130 && item.y === 220),
      false,
    );
    assert.equal(
      contents.some((item) => item.x === 410 && item.y === 220),
      false,
    );
  });

  it("两个解除拦截说明文件随 DMG 分发，并落在背景箭头指向的位置", () => {
    const guides = guideEntries.map((item) => ({
      name: basename(item.path ?? ""),
      x: item.x,
      y: item.y,
      exists: Boolean(item.path && existsSync(item.path)),
    }));

    // 说明文件 y=365 是本仓相对上游的微调（上游为 370）。
    assert.deepEqual(guides, [
      { name: "解除拦截.txt", x: 170, y: 365, exists: true },
      { name: "Unblock.txt", x: 450, y: 365, exists: true },
    ]);
  });

  it("所有可见图标都在背景图下沿以内，打开 DMG 无需滚动", () => {
    const { height } = readPngSize(backgroundPath);
    for (const item of visibleContents) {
      assert.notEqual(item.y, undefined);
      assert.ok((item.y ?? Number.POSITIVE_INFINITY) < height - 80);
    }
  });

  it("说明文件包含绝对路径的解除命令", () => {
    for (const item of guideEntries) {
      const text = readFileSync(item.path ?? "", "utf8");
      assert.ok(text.includes("sudo /usr/bin/xattr -rd com.apple.quarantine"));
      assert.ok(text.includes("/Applications/yazcode.app"));
    }
  });
});
