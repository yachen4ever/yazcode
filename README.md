# yazcode

<div align="center">
  <img src="public/logo/open-audit.svg" alt="yazcode" width="96" height="96" />
  <p><strong>ZCode → ZCodium 审计脉络的私人工作 agent 发行版</strong></p>
</div>

> yazcode 是一个**私人使用**的 AI 工作区发行版：以 ZCode 为底座，面向桌面、浏览器与终端三端，覆盖编程、办公文档、数据分析与桌面自动化。所有数据落在本地，运行不依赖任何官方服务。

## 底座：ZCode

yazcode 的底座是 [ZCode](https://github.com/zai-org/ZCode)——Z.ai 于 2026 年 9 月开源的编程 Agent。底座提供的产品形态在本仓库中原样保留：

- **一个 Agent，三种界面**：Electron 桌面端、浏览器工作区和 `yazcode` 终端 TUI 共用同一个 Agent 运行时与会话；支持 SSH 远程主机与手机浏览器远控。
- **会规划、会改、会跑、会验证**：文件改动用 diff 呈现，终端命令带上下文；每一次编辑、命令和工具调用都可以要求审批——仅本次允许、本项目内一直允许，或完全放行。
- **多智能体协作**：子代理、动态工作流、技能与定时自动化。
- **插件、技能与 MCP**：内置技能与插件体系，各自独立开关；支持第三方插件市场。

## 底座之上的变动

yazcode 在底座之上做了两类变动：**从其他开源仓库引入**（每项注明来源与许可）与 **yazcode 自研**。完整来源与修订声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

### 从其他仓库引入

| 能力 | 来源仓库 | 许可 | 说明 |
| ---- | ---- | ---- | ---- |
| 审计加固（遥测移除） | [ZCodium-project/ZCodium](https://github.com/ZCodium-project/ZCodium) | MIT | 移除约 2.6 万行监控遥测、官方服务默认关闭；yazcode 的历史底座（现转为独立线，通用改进先进入我们的 [zcodium fork](https://github.com/yachen4ever/ZCodium) 再回馈上游）。 |
| Computer Use 桌面操控 | [axiom-desu/ZCodium](https://github.com/axiom-desu/ZCodium) | Apache-2.0 | 原生层复用 MIT 的 [trycua/cua](https://github.com/trycua/cua) `@trycua/cua-driver`（Rust，Win32 E2E 122/122）；插件默认启用、驱动回收自愈。 |
| 办公制作向插件 | [zai-org/ZCode](https://github.com/zai-org/ZCode) 3.15.1 | Apache-2.0 | 官方 pdf / documents / spreadsheets 插件：排版工作流、docx-js 设计系统、图表与 VBA 模板，配套 `visual-judge` 渲染质检子代理。 |
| 办公处理向技能（ops 系） | [MiniMaxAI/minimax-code](https://github.com/MiniMaxAI/minimax-code) | MIT | docx / xlsx / pptx / pdf 的处理纪律版，已完成去残留（品牌、修订作者、宿主专有通道）。 |
| OpenViking 客户端运行时 | [volcengine/OpenViking](https://github.com/volcengine/OpenViking) | Apache-2.0（`examples/`） | 外部记忆服务的客户端集成（语义召回 + 自动沉淀），随包分发；服务端独立部署、两者不耦合。 |

### yazcode 自研

- **独立身份与数据目录**：用户数据在 `~/.yazcode`（自动从旧目录迁移）；env 前缀 `YAZCODE_*`；协议 `yazcode://`；CLI 命令 `yazcode`；版本线独立（见 [CHANGELOG.md](CHANGELOG.md)）。
- **去智谱**：移除智谱订阅体系（Coding Plan / Start Plan、`zhipu-account` 访问类型、首启套餐引导）——Z.AI / BigModel 保留为普通 API-Key 预设；builtin 供应商只来自本仓库经审计的 `config/provider/zcode-builtin.json`。
- **记忆提供方三选一**：内置文件记忆（跨会话自动提炼，按项目隔离）/ OpenViking / 不启用。三态互斥、无静默回落——选了 OpenViking 而服务不可达时直接报错。
- **服务商级 TLS 二选一**：自签网关可**导入自签证书（钉扎，推荐）**或「跳过 TLS 证书校验」，仅该端点生效、互斥不并存；Node fetch 不读系统证书库，机器级装信任无效。
- **视觉桥接**：主模型不支持图片输入时，自动把消息中的图片交给用户指定的 fallback 视觉模型转成文字描述并重试一次——无需手动转述，失败驱动无需预判（适配不返回模态元数据的 openai 兼容网关）。
- **内嵌浏览器下载静默落盘**：IAB 附件下载不再弹「另存为」，自动保存 `Downloads/yazcode/`（重名加序号，失败回退对话框）。
- **模型元数据与检测**：接入端点可从 `/models` 自动检测模型；按模型配置上下文窗口、输入模态、能力与推理档位（含推理参数映射）。
- **质量门禁**：`check-skill-residue`（vendored 技能的宿主品牌/端口残留拦截）、`typecheck:cli`（全部 13 个 CLI 子包）、`dist/provider` 缺失时打包 fail-closed、许可台账逐字节校验。

## 变更日志

版本要点见 [CHANGELOG.md](CHANGELOG.md)；每个版本的完整产物与说明见
[Releases](https://github.com/yachen4ever/yazcode/releases)（由 [Release workflow](https://github.com/yachen4ever/yazcode/actions/workflows/release.yml) 构建自本仓库源码）。

## 安装

[Releases](https://github.com/yachen4ever/yazcode/releases) 页面提供桌面客户端（macOS / Windows / Linux）与 CLI 发行包。

**关于签名**：构建产物**未经 Z.ai 签名**，操作系统会阻止首次启动——这是预期行为。建议先对照 release 页的 `sha256.txt` 校验下载文件（`shasum -a 256` / `sha256sum` / `certutil -hashfile <file> SHA256`）。

### macOS（.dmg）

1. 下载 `yazcode-*-mac-arm64.dmg`（Apple Silicon）或 `yazcode-*-mac-x64.dmg`（Intel），打开后把 yazcode 拖入「应用程序」。
2. Gatekeeper 会提示开发者无法验证。**拖入应用程序后**执行：

   ```bash
   # 一次性命令（解除隔离并启动；命令会立即退出）：
   sudo /usr/bin/xattr -rd com.apple.quarantine "/Applications/yazcode.app" && open -a "yazcode"
   ```

   也可以在 Finder 中右键应用 → 打开 → 再次点「打开」，之后即可正常双击启动。

### Windows（.exe）

1. 下载 `yazcode-*-win-x64.exe` 双击安装。
2. SmartScreen 会提示「Windows 已保护你的电脑」——点「更多信息」→「仍要运行」，完成安装。

### Linux（.AppImage）

```bash
chmod +x yazcode-*-linux-x86_64.AppImage   # arm64 构建对应 -arm64 包
./yazcode-*-linux-x86_64.AppImage
```

### CLI 发行包（.tar.gz）

自包含 bundle（TUI + Web + Agent），需要 Node.js 24；安装脚本与运行时代码都可以在本仓库审阅：

```bash
tar -xzf yazcode-*.tar.gz && cd yazcode
./install.sh      # 安装 yazcode 命令（默认 ~/.yazcode/runtime，入口在 ~/.local/bin）
yazcode --help
```

## 从源码构建

依赖：Git、Node.js **24.14.0**、pnpm **10.33.2**——[mise.toml](mise.toml) 是工具版本唯一事实源（`mise install` 一键装好）。

```bash
pnpm install
pnpm dev:desktop                     # Electron 桌面端
pnpm dev:web                         # Web 客户端 + 服务端
pnpm --filter @zcode/cli dev         # Agent CLI / TUI
pnpm build:zcode                     # CLI 发行包
```

## 仓库结构

```text
apps/zcode-cli/           Agent CLI 与运行时（bootstrap / core / adapters / cli 等 13 个子包），
                          其 packages/ 下的官方插件（browser-use、computer-use、办公三插件等）随包分发
packages/
  desktop/ web/ ui/       桌面端、Web 客户端与共享 React 组件 / Zustand store
  services/               业务服务（含 OpenViking 集成、模型设置）
  provider/ provider-node/ 模型执行链与协议适配（含 TLS 钉扎/跳过）
  shared/                 共享协议、类型与设置 schema
  rpc/ client/ server/    RPC 框架、Agent 客户端 SDK 与服务端
  zcode-cua/              Computer Use 运行时适配器
  model-option-map/       模型推理档位参数映射
vendor/openviking/        OpenViking 客户端集成运行时（Apache-2.0，vendored）
config/provider/          builtin 供应商配置（唯一事实源，经审计）
.agents/skills/           仓库级技能（处理向 ops 系、研发向技能）
docs/                     仓库导航、行为 spec、验收与交付报告
third-party/              许可快照与 copied-components 台账
scripts/                  构建、打包、门禁与架构检查脚本
```

仓库工程纪律见 [AGENTS.md](AGENTS.md)；导航与 spec 索引见 [docs/README.md](docs/README.md)；UI 规范与插件商店词汇见 [DESIGN.md](DESIGN.md) / [CONTEXT.md](CONTEXT.md)。

## 版本体系

yazcode 使用**年份号段** `26.y.z`，与上游 `3.14.x` 及社区 fork 的 `1.y.z` 都不重叠，便于一眼分辨构建来源：

- **y（次版本）——引入上游变更的批次**：从上游（zai-org/ZCode 或生态 fork）吸收功能、修复或插件时递增。
- **z（修订号）——纯内部迭代**：不涉及上游变更的 yazcode 自身功能、修复与产品变更时递增。
- 同日重复构建追加 `-audit.<日期>[.n]` 后缀；破坏性变更（如数据目录迁移）会在 release 说明中显式标注。

值得共享的改进先进入我们的 [zcodium fork](https://github.com/yachen4ever/ZCodium)，再以 PR 回馈 [ZCodium-project](https://github.com/ZCodium-project/ZCodium)。

## 致谢

本仓库站在这些开源工作的肩膀上，向它们致谢：

- [zai-org/ZCode](https://github.com/zai-org/ZCode)——底座与官方办公插件；
- [ZCodium-project/ZCodium](https://github.com/ZCodium-project/ZCodium)——系统性的遥测审计与移除；
- [axiom-desu/ZCodium](https://github.com/axiom-desu/ZCodium) 与 [trycua/cua](https://github.com/trycua/cua)——Computer Use 的适配层与原生引擎；
- [MiniMaxAI/minimax-code](https://github.com/MiniMaxAI/minimax-code)——办公处理向技能；
- [volcengine/OpenViking](https://github.com/volcengine/OpenViking)——外部记忆服务与客户端集成。

审计工作源于下述监控与数据外传发现；本仓库不在此之外做额外事实认定：

| 来源 | 链接 |
| ---- | ---- |
| ferstar 原始技术分析 | https://blog.ferstar.org/posts/zcode-silent-workspace-snapshot-upload/ |
| 独立复现 | https://blog.margrop.net/post/zcode-silent-git-upload-investigation/ |
| 澎湃新闻报道 | https://www.thepaper.cn/newsDetail_forward_34111815 |

## 许可与免责声明

本仓库为私人使用的开源衍生项目（MIT），与 Z.ai 或任何商业公司无关。所有事实均来自公开报道与独立代码审计并注明出处；如相关方认为内容不实，请提 issue。

第三方组件的许可与修订声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
