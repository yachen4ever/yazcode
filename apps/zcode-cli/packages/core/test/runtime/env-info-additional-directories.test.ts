import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildEnvInfoSection } from "../../src/context/sections/env-info.js";
import type { EnvInfo } from "@zcode/contracts";

// 多目录项目 P2（docs/specs/multi-root-projects.md 信任边界白名单）：
// EnvInfo.additionalDirectories 只用于 Environment Info 段展示；
// 缺席/空数组不渲染该行（单目录会话环境形状与历史逐字节一致）。

function baseEnvInfo(): EnvInfo {
  return {
    cwd: "/repo/main",
    platform: "darwin",
    shell: "zsh",
    osVersion: "darwin 27.0.0 arm64",
    nodeVersion: "v22.0.0",
  };
}

describe("buildEnvInfoSection：additionalDirectories 展示", () => {
  it("携带附加目录时渲染 Additional working directories 行", () => {
    const section = buildEnvInfoSection({
      ...baseEnvInfo(),
      additionalDirectories: ["/repo/secondary", "/repo/docs"],
    });
    assert.ok(section.content.includes("- Additional working directories: /repo/secondary, /repo/docs"));
    // 顺序：紧跟 Primary working directory 之后。
    const cwdIndex = section.content.indexOf("- Primary working directory:");
    const additionalIndex = section.content.indexOf("- Additional working directories:");
    const gitIndex = section.content.indexOf("- Is a git repository:");
    assert.ok(cwdIndex >= 0 && additionalIndex > cwdIndex && gitIndex > additionalIndex);
  });

  it("缺席或空数组不渲染该行（单目录会话形状不变）", () => {
    for (const envInfo of [baseEnvInfo(), { ...baseEnvInfo(), additionalDirectories: [] }]) {
      const section = buildEnvInfoSection(envInfo);
      assert.equal(section.content.includes("Additional working directories"), false);
    }
  });
});
