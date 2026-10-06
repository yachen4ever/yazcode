# yazcode

<div align="center">
  <img src="public/logo/open-audit.svg" alt="yazcode" width="96" height="96" />
  <p><strong>ZCode → ZCodium 审计脉络的私人工作 agent 发行版</strong></p>
</div>

> yazcode 是一个**私人使用**的 AI 工作区发行版：以 ZCodium 社区审计的代码为底座，面向桌面、浏览器与终端三端，覆盖编程、办公文档、数据分析与桌面自动化。所有数据落在本地，运行不依赖任何官方服务。

## 项目脉络

yazcode 站在四条开源工作线的成果之上，与它们的关系如下：

| 项目 | 仓库 | 许可 | 与 yazcode 的关系 |
| ---- | ---- | ---- | ---------------- |
| **ZCode** | [zai-org/ZCode](https://github.com/zai-org/ZCode) | 开源（Z.ai） | 一切工作的源头：2026 年 9 月开源的编程 Agent。 |
| **ZCodium** | [ZCodium-project/ZCodium](https://github.com/ZCodium-project/ZCodium) | MIT | 社区审计 fork：移除约 2.6 万行监控遥测、官方服务默认关闭。yazcode 的底座；无争议的修复与小功能以 PR 回馈（[#31](https://github.com/ZCodium-project/ZCodium/pull/31)、[#33](https://github.com/ZCodium-project/ZCodium/pull/33)、[#35](https://github.com/ZCodium-project/ZCodium/pull/35)、[#37](https://github.com/ZCodium-project/ZCodium/pull/37)）。 |
| **ZCodium Exp.** | [axiom-desu/ZCodium](https://github.com/axiom-desu/ZCodium) | Apache-2.0 | 平行独立衍生：以开源组件补全官方发布包功能。yazcode 的 **Computer Use 运行时**移植自这里。 |
| **MiniMax code** | [MiniMaxAI/minimax-code](https://github.com/MiniMaxAI/minimax-code) | MIT | **办公四件套技能**（docx / xlsx / pptx / pdf）的来源。 |
| **trycua/cua** | [trycua/cua](https://github.com/trycua/cua) | MIT | CUA 原生引擎 `@trycua/cua-driver`：Rust 实现的跨平台桌面操控（Win32 E2E 122/122）。 |

另有社区审计文档线：[ZCodium 项目网站](https://zcodium-project.github.io/)；英文版说明见 [README_EN.md](README_EN.md)（已停止跟进，以本文件为准）。

## yazcode 保留了什么

产品底座不变——规划型 Agent 编辑代码、执行命令、自我验证并驱动真实浏览器：

- **一个 Agent，三种界面**：Electron 桌面端、浏览器工作区和 `yazcode` 终端 TUI 共用同一个 Agent 运行时与会话；支持 SSH 远程主机与手机浏览器远控。
- **会规划、会改、会跑、会验证**：文件改动用 diff 呈现，终端命令带上下文；每一次编辑、命令和工具调用都可以要求审批——仅本次允许、本项目内一直允许，或完全放行。
- **多智能体协作**：子代理、动态工作流、技能与定时自动化。
- **插件、技能与 MCP**：内置技能与插件体系，各自独立开关；支持第三方插件市场。
- **模型自由选**：内置 DeepSeek、OpenAI、Anthropic、Moonshot Kimi、MiniMax、智谱 Z.AI（GLM）、阿里云、xAI、小米 MiMo、OpenRouter 等预设，也支持完全自定义端点（Chat Completions / Responses / Anthropic Messages），并可从供应商的 `/models` 端点自动检测可用模型。
- **原生记忆层**：Agent 跨会话自动提炼并记忆操作事实（`~/.yazcode/cli/memories/`，按项目隔离，索引随会话注入），可一键关闭。

## 继承自 ZCodium 的加固

与上游开源版相比，本仓库**不包含任何监控与遥测实现**：

| 领域 | 移除内容 |
| ---- | -------- |
| 客户端监控 SDK | 阿里云 ARMS RUM（`@arms/rum-electron`）及其补丁、初始化、路由埋点、渲染层桥接 |
| 用量与网络遥测 | 网络指标聚合上报、API 事件采集、host/scheduler 转发、远程会话使用采样 |
| 资源与性能 | 周期性资源采样、内存诊断、数据量统计、TTFT 导出、MCP 遥测 |
| 崩溃采集 | 崩溃转储上报、OOM 注记、稳定性遥测 |
| CLI 遥测 | 整个 `@zcode/telemetry` 包（OTLP 导出、模型 API 记录、Agent 指标与追踪） |
| UI 埋点 | 会话打开、订阅报错、自动化、提示词模板与用户行为埋点，以及平台上报方法与 IPC 桥 |
| 协议与配置 | 遥测事件协议与上报路径；新增过滤，历史遥测环境变量无法重新进入 Agent |

**有意保留**：本地日志（用于排查）、用户主动发起的反馈，以及正常业务请求（模型调用、更新检查）。各包移除报告：[desktop](packages/desktop/specs/telemetry-removal-report.md)、[CLI](apps/zcode-cli/specs/telemetry-removal-report.md)、[UI](packages/ui/specs/telemetry-removal-report.md)。

## yazcode 自己做了什么

### 独立身份与去智谱

- **独立数据目录与命名**：用户数据在 `~/.yazcode`（自动从旧 `~/.zcode` / `~/.zcodium` 迁移）；env 前缀 `YAZCODE_*`；协议 `yazcode://`；CLI 命令 `yazcode`；版本线独立（见下）。
- **去智谱**：移除智谱订阅体系（Coding Plan / Start Plan 供应商、`zhipu-account` 访问类型、首启套餐引导）——Z.AI / BigModel 保留为普通 API-Key 预设。官方 CDN builtin 配置源停用，builtin 供应商只来自本仓库经审计的 `config/provider/zcode-builtin.json`。
- **硬数据根边界**：显式设置数据根环境变量后即为硬边界——桌面启动引导不再回读真实 HOME 的设置文件。
- **模型检测**：给自定义 Provider 添加模型时，可查询该供应商的 `/models` 端点，从检测结果中点选回填模型 ID。
- **版本号可见**：侧栏底部应用名旁直接展示当前版本（`v1.0.5` 样式）。

### Computer Use 桌面操控

从 [axiom-desu/ZCodium](https://github.com/axiom-desu/ZCodium) 整体移植（其实现为净室替代，原生层复用 MIT 许可的 [trycua/cua](https://github.com/trycua/cua) `@trycua/cua-driver`，无 Z.AI 专有代码）：

- Agent 可截屏观察桌面、驱动鼠标键盘、按 UI 元素精准操作原生应用；Windows 走 UIA，Win32 动作 E2E 122/122。
- 插件默认启用；驱动会话被内核回收时适配层自动复活并重试（`session_ended` 自愈），对模型透明。
- 原生模块（`.node` / `.dll`）随安装包分发，路径在打包链中 fail-closed 校验。

### 办公四件套技能

自 [MiniMaxAI/minimax-code](https://github.com/MiniMaxAI/minimax-code)（MIT）移植 docx / xlsx / pptx / pdf 四个技能，并完成**去残留**：

- C# 程序集 `MiniMaxAIDocx.*` → `YazOffice.*`（42 处改名）；
- 修订记录作者默认值（宿主 daemon 名）→ `yazcode`——这类值会写进用户文档的修订历史；
- 移除宿主专有的桌面截图通道与 sidecar 协议（`127.0.0.1:5321` POST 等），扫描页阅读改为 poppler 渲染 + 原生读图；
- 四个技能目录随附上游 LICENSE 副本，来源与修订声明进 `THIRD-PARTY-NOTICES.md` 台账。

### 质量门禁

- `check-skill-residue`：vendored 技能的宿主品牌 / 专有端口残留回流拦截（接入 pre-push 与 CI）。
- `typecheck:cli`：CLI 包类型检查接入 release 管线（构建后、分发前），修复了 ambient 类型声明不随 import 图传播导致的 TS7016。
- CLI 构建的 `dist/provider` 随桌面打包暂存，缺失时打包直接失败（不静默产出坏包）。

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

Release 由本仓库的 [Release workflow](https://github.com/yachen4ever/yazcode/actions/workflows/release.yml) 构建；所有产物均来自此处经审计的源码。

## 版本体系

yazcode 使用自己的版本线，从 `1.0.0` 起步，与上游 `3.14.x` 编号无关：

- **y（次版本）——同步上游**：某个 release 包含经审计后同步的上游 ZCode/ZCodium 变更时递增。对应的上游 commit 记录在该 release 说明里。
- **z（修订号）——yazcode 自身迭代**：yazcode 自己的功能、修复与产品变更时递增。
- 同日重复构建追加 `-audit.<日期>[.n]` 后缀；破坏性变更（如数据目录迁移）会在 release 说明中显式标注。

## 仓库文档

| 文档 | 内容 |
| ---- | ---- |
| [docs/README.md](docs/README.md) | 仓库导航：模块阅读包、spec 索引、可执行门禁清单 |
| [docs/handoff-work-agent.md](docs/handoff-work-agent.md) | 工作使用侧的交接文档（技能生态、办公机部署、记忆层约定） |
| [DESIGN.md](DESIGN.md) | UI 设计规范 |
| [CONTEXT.md](CONTEXT.md) | 插件商店领域词汇 |
| [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) | 第三方许可台账（含本文提到的全部来源） |

## 免责声明

本仓库为私人使用的开源衍生项目（MIT），与 Z.ai 或任何商业公司无关。所有事实均来自公开报道与独立代码审计并注明出处；如相关方认为内容不实，请提 issue。

## 背景报道

审计工作源于下述监控与数据外传发现；本仓库不在此之外做额外事实认定：

| 来源 | 链接 |
| ---- | ---- |
| ferstar 原始技术分析 | https://blog.ferstar.org/posts/zcode-silent-workspace-snapshot-upload/ |
| 独立复现 | https://blog.margrop.net/post/zcode-silent-git-upload-investigation/ |
| 官方开源仓库（上游） | https://github.com/zai-org/ZCode |
| 澎湃新闻报道 | https://www.thepaper.cn/newsDetail_forward_34111815 |
| 界面新闻报道 | https://www.jiemian.com/article/15120609.html |
| ITHome 报道 | https://www.ithome.com/1/005/046.htm |
| 虎嗅报道 | https://www.huxiu.com/article/4892416.html |
| 凤凰网报道 | https://tech.ifeng.com/c/8waIS4X7FAe |

## 许可

[MIT](LICENSE)——继承自上游开源版本。

本文引用的第三方项目按其各自许可分发与致谢：[ZCodium-project/ZCodium](https://github.com/ZCodium-project/ZCodium) 与 [axiom-desu/ZCodium](https://github.com/axiom-desu/ZCodium)（MIT / Apache-2.0）、[trycua/cua](https://github.com/trycua/cua)（MIT）、[MiniMaxAI/minimax-code](https://github.com/MiniMaxAI/minimax-code)（MIT）；完整清单见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

上游 [ZCode README](https://github.com/zai-org/ZCode#readme) 描述上游项目本身；其社区链接、服务与承诺由 Z.ai 维护，不属于本 fork 的内容。
