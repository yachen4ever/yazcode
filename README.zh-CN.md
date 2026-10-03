# yazcode

<div align="center">
  <img src="public/logo/open-audit.svg" alt="yazcode" width="96" height="96" />
  <p><strong>ZCode → ZCodium 审计脉络的独立延续</strong></p>
</div>
<p align="center">
  简体中文 | <a href="README.md">English</a> ·
  <a href="https://zcodium-project.github.io/">ZCodium 项目网站</a>
</p>

> yazcode 是面向桌面、浏览器与终端三端的 AI 编程工作区，以自己的名字独立维护，延续 ZCodium 项目开创的安全审计工作。所有结论以代码和可复现的验证为准。

## 脉络：ZCode → ZCodium → yazcode

| 项目 | 仓库 | 定位 |
| ---- | ---- | ---- |
| **ZCode** | [zai-org/ZCode](https://github.com/zai-org/ZCode) | 智谱 2026 年 9 月 21 日开源的编程 Agent，本仓库一切工作的源头。 |
| **ZCodium** | [ZCodium-project/ZCodium](https://github.com/ZCodium-project/ZCodium) | 社区审计 fork：移除约 2.6 万行监控遥测、官方服务默认关闭。因更新停滞，由 yazcode 延续其工作。 |
| **yazcode** | 本仓库 | 以自己的名字独立延续 ZCodium：独立数据目录（`~/.yazcode`）、独立环境变量前缀（`YAZCODE_*`）、独立协议（`yazcode://`）、独立版本线，并完整移除智谱订阅体系。 |

yazcode 与两条上游的实际关系：

- 两条上游都配置为 git remote（`zcode` → zai-org/ZCode，`zcodium` → ZCodium-project/ZCodium），其变更先做 diff 审计、再择无风险者同步。
- 产品级决策（数据目录更名、去智谱）**仅属于 yazcode**；无争议的缺陷修复与小功能仍会以 PR 形式回提给 ZCodium。
- 用户数据在 `~/.yazcode`——首次启动自动从旧 `~/.zcode`（官方客户端）或 `~/.zcodium`（早期 yazcode 构建）迁移。

## yazcode 保留了什么

产品本身不变——规划型 Agent 编辑代码、执行命令、自我验证并驱动真实浏览器：

- **一个 Agent，三种界面**：Electron 桌面端、浏览器工作区和 `yazcode` 终端 TUI 共用同一个 Agent 运行时与会话；支持 SSH 远程主机与手机浏览器远控。
- **会规划、会改、会跑、会验证**：文件改动用 diff 呈现，终端命令带上下文；每一次编辑、命令和工具调用都可以要求审批——仅本次允许、本项目内一直允许，或完全放行。
- **多智能体协作**：子代理、动态工作流、技能与定时自动化。
- **插件、技能与 MCP**：内置技能与插件体系，各自独立开关。
- **模型自由选**：内置 DeepSeek、OpenAI、Anthropic、Moonshot Kimi、MiniMax、智谱 Z.AI（GLM）、阿里云、xAI、小米 MiMo、OpenRouter 等预设，也支持完全自定义端点（Chat Completions / Responses / Anthropic Messages）。自定义 Provider 支持通过其 `/models` 端点自动检测可用模型。

## yazcode 移除与加固了什么

### 继承自 ZCodium

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

### yazcode 新增

- **去智谱**：移除智谱订阅体系（Coding Plan / Start Plan 供应商、`zhipu-account` 访问类型、首启套餐引导）——Z.AI / BigModel 保留为普通 API-Key 预设，与 DeepSeek、Kimi 同级。官方 CDN builtin 配置源停用，builtin 供应商只来自本仓库经审计的 `config/provider/zcode-builtin.json`。
- **独立身份与数据目录**：用户数据在 `~/.yazcode`（自动从旧 `~/.zcode` / `~/.zcodium` 迁移）；env 前缀 `YAZCODE_*`；协议 `yazcode://`；CLI 命令 `yazcode`。
- **硬数据根边界**：显式设置数据根环境变量后即为硬边界——桌面启动引导不再回读真实 HOME 的设置文件。
- **模型检测**：给自定义 Provider 添加模型时，可查询该供应商的 `/models` 端点，从检测结果中点选回填模型 ID。

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

## 社区

| Discord | QQ 群 |
| ------- | ----- |
| <img src="docs/community/discord-qr.png" alt="Discord 邀请二维码" width="220" /> | <img src="docs/community/qq-group-qr.jpg" alt="QQ 群二维码" width="220" /> |
| https://discord.gg/HeDkhY9nV | 群号：344502652 |

## 免责声明

本仓库为社区驱动的开源项目（MIT），与 Z.ai 或任何商业公司无关。所有事实均来自公开报道与独立代码审计并注明出处；如相关方认为内容不实，请提 issue。

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

上游 [ZCode README](https://github.com/zai-org/ZCode#readme) 描述上游项目本身；其社区链接、服务与承诺由 Z.ai 维护，不属于本 fork 的内容。

另有一个同名的独立项目 [axiom-desu/yazcode](https://github.com/axiom-desu/yazcode)，与本仓库无关。
