// 官方插件的桌面打包 stage 清单：把插件源目录按 bootstrap rootCandidates 的期望复制到
// bundled-agents/<platform>/glm/packages/*-plugin。与
// apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts 平行维护。
//
// 为什么单独成模块：这份清单与 bootstrap 定义是两份平行事实，历史上两次漏改——
// browser-use 的 runtime 归属挪到 node-repl-host 时打包准备照旧去 browser-use 要
// dist/mcp/server.js 直接挂掉（构建期可发现），gen-ui P1 新增 visualize 插件时清单没加，
// 而 stageOfficialPlugins 的 requiredSeedPaths 校验只覆盖清单内条目，漏条目静默无感知
// （filesystem seed 对解析不到 root 的插件是 flatMap 跳过），直到 26.2.0 workwin 实测
// 才暴露。official-plugin-stage-list.test.ts 守护两份清单同步：definitions 里凡带
// listing（市场上架、内容型）的插件必须在这里有条目，且 requiredSeedPaths 不落后。
// 无 listing 的 headless 工具插件（android-emulator/image-search/ios-simulator 等）
// 有意不随桌面包分发，不在此列。

export const BROWSER_USE_PLUGIN_PACKAGE_NAME = "@zcode/browser-use-plugin";

// browser-use 只携带自己的 client script 与 skill/docs；node_repl MCP runtime 归
// @zcode/node-repl-host（见下方条目注释）。
const browserUseRequiredRuntimePaths = [
  "scripts/browser-client.mjs",
  "docs/api.json",
  "docs/documents.json",
  "docs/overview.md",
  // documents.json 已暴露 recording lookup，桌面安装包不能复用缺少正文的 runtime。
  "docs/recording.md",
  "docs/workflow.md",
  "skills/control-browser/SKILL.md",
  "skills/web-gui-tester/SKILL.md",
];

export const OFFICIAL_PLUGIN_STAGE_LIST = [
  {
    definitionName: "browser-use",
    packageName: "@zcode/browser-use-plugin",
    relativePath: "apps/zcode-cli/packages/browser-use-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: browserUseRequiredRuntimePaths,
    runtimeBuildScript: "scripts/build.mjs",
    stagedPath: "packages/browser-use-plugin",
  },

  {
    // node_repl 宿主：Browser Use 与 Computer Use 共用的 MCP runtime，本轮抽成独立包。
    // 它没有 listing（不进插件市场展示面），但生产包首启 seed 必须拿到它的 dist runtime，
    // 否则 bua/cua 任一开启时都会连不上 node_repl。
    definitionName: "node-repl-host",
    packageName: "@zcode/node-repl-host",
    relativePath: "apps/zcode-cli/packages/node-repl-host",
    requiresRuntime: true,
    requiredRuntimePaths: ["dist/mcp/server.js"],
    runtimeBuildScript: "scripts/build.mjs",
    stagedPath: "packages/node-repl-host",
  },

  {
    // Computer Use 模型可见面（skill/docs/client script）。无独立 dist runtime：
    // 原生执行由共享 node_repl host 携带（见上方条目 + stageOfficialPlugins 里的
    // @trycua/cua-driver 暂存），权威归属见 bootstrap/official-plugin-definitions.ts。
    definitionName: "computer-use",
    packageName: "@zcode/zcode-cua-plugin",
    relativePath: "apps/zcode-cli/packages/zcode-cua-plugin",
    requiresRuntime: false,
    requiredRuntimePaths: [],
    requiredSeedPaths: [
      "docs/computer-use.md",
      "scripts/computer-use-client.mjs",
      "scripts/computer-use-errors.mjs",
      "scripts/computer-use-envelope.mjs",
      "scripts/computer-use-keys.mjs",
      "scripts/computer-use-target.mjs",
      "skills/computer-use/SKILL.md",
    ],
    stagedPath: "packages/zcode-cua-plugin",
  },

  // 26.1.0 引入的上游官方办公插件（Apache-2.0，纯 skills/agents 无 runtime），见
  // docs/specs/office-plugins-introduction.md。与 scripts/prepare-prebuilds.mjs、
  // packages/server/src/remote/zcodeAgentOfficialPluginAssets.ts 三份清单保持一致。
  {
    definitionName: "pdf",
    packageName: "@zcode/pdf-plugin",
    relativePath: "apps/zcode-cli/packages/pdf-plugin",
    requiresRuntime: false,
    requiredRuntimePaths: [],
    requiredSeedPaths: ["agents/visual-judge.md", "skills/pdf/SKILL.md"],
    stagedPath: "packages/pdf-plugin",
  },
  {
    definitionName: "documents",
    packageName: "@zcode/documents-plugin",
    relativePath: "apps/zcode-cli/packages/documents-plugin",
    requiresRuntime: false,
    requiredRuntimePaths: [],
    requiredSeedPaths: ["agents/visual-judge.md", "skills/docx/SKILL.md"],
    stagedPath: "packages/documents-plugin",
  },
  {
    definitionName: "spreadsheets",
    packageName: "@zcode/spreadsheets-plugin",
    relativePath: "apps/zcode-cli/packages/spreadsheets-plugin",
    requiresRuntime: false,
    requiredRuntimePaths: [],
    requiredSeedPaths: ["agents/visual-judge.md", "skills/xlsx/SKILL.md"],
    stagedPath: "packages/spreadsheets-plugin",
  },

  {
    // Gen UI P1：会话内联可视化的产出指导技能（vendored 自上游 visualize-plugin 0.1.0，
    // Apache-2.0，含 d3/lucide/floating-ui vendored 资产）。纯静态技能资产，无 dist runtime。
    // requiredSeedPaths 镜像 bootstrap 定义（含 assets/vendor 整组）；漏 stage 时
    // filesystem seed 静默跳过，会话里技能不可见，agent 退化为把 fragment 写进 Git 工作区
    // （26.2.0 workwin 实测）。
    definitionName: "visualize",
    packageName: "@zcode/visualize-plugin",
    relativePath: "apps/zcode-cli/packages/visualize-plugin",
    requiresRuntime: false,
    requiredRuntimePaths: [],
    requiredSeedPaths: [
      "skills/visualize/SKILL.md",
      "skills/visualize/references/api.md",
      "skills/visualize/references/styles.md",
      "skills/visualize/tweak.md",
      "skills/visualize/LICENSE.md",
      "skills/visualize/scripts/render.py",
      "skills/visualize/assets/visualize.css",
      "skills/visualize/assets/visualize.html",
      "skills/visualize/assets/calendar.js",
      "skills/visualize/assets/runtime-manifest.json",
      "skills/visualize/scripts/vendor.py",
      "skills/visualize/assets/vendor/manifest.json",
      "skills/visualize/assets/vendor/floating-ui-core-1.7.3.min.js",
      "skills/visualize/assets/vendor/floating-ui-core-1.7.3.min.js.LICENSE",
      "skills/visualize/assets/vendor/floating-ui-dom-1.7.4.min.js",
      "skills/visualize/assets/vendor/floating-ui-dom-1.7.4.min.js.LICENSE",
      "skills/visualize/assets/vendor/lucide-1.17.0.js",
      "skills/visualize/assets/vendor/lucide-1.17.0.js.LICENSE",
      "skills/visualize/assets/vendor/d3-7.9.0.min.js",
      "skills/visualize/assets/vendor/d3-7.9.0.min.js.LICENSE",
      "skills/visualize/widgets/calendar.md",
      "skills/visualize/examples/calendar.html",
      "skills/visualize/assets/standalone-host-bridge.js",
      "skills/visualize/assets/standalone-shell.js",
    ],
    stagedPath: "packages/visualize-plugin",
  },
];

// 每个插件从源目录复制进 stage 目标时只带这些顶层路径。
export const INCLUDED_OFFICIAL_PLUGIN_TOP_LEVEL_PATHS = new Set([
  ".mcp.json",
  ".zcode-plugin",
  "README.md",
  // Electron 生产资源复制有独立白名单，遗漏 agents 会让首启 filesystem seed 永久缺少子代理。
  "agents",
  "commands",
  "dist",
  "docs",
  "hooks",
  "output-styles",
  "package.json",
  "scripts",
  "skills",
  "templates",
]);

export const EXCLUDED_OFFICIAL_PLUGIN_ASSET_NAMES = new Set([
  ".DS_Store",
  ".venv",
  "__pycache__",
  "node_modules",
]);
