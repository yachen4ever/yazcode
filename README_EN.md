# yazcode

<div align="center">
  <img src="public/logo/open-audit.svg" alt="yazcode" width="96" height="96" />
  <p><strong>Independent continuation of the ZCode → ZCodium audit lineage</strong></p>
</div>
<p align="center">
  <a href="README.md">简体中文</a> | English ·
  <a href="https://zcodium-project.github.io/">ZCodium project site</a>
</p>

> yazcode is an AI coding workspace for desktop, browser and terminal — independently maintained under its own name, carrying forward the security-audit work started by the ZCodium project. Everything here is backed by code and reproducible checks.

## Lineage: ZCode → ZCodium → yazcode

| Project | Repository | What it is |
| ------- | ---------- | ---------- |
| **ZCode** | [zai-org/ZCode](https://github.com/zai-org/ZCode) | Z.ai's coding agent, open-sourced by Zhipu on September 21, 2026. The origin of everything here. |
| **ZCodium** | [ZCodium-project/ZCodium](https://github.com/ZCodium-project/ZCodium) | The community audit fork: ~26k lines of monitoring/telemetry removed, vendored services off by default. Its development pace stalled, so yazcode continues the work. |
| **yazcode** | this repository | Independent continuation of ZCodium under its own name: own data directory (`~/.yazcode`), own env prefix (`YAZCODE_*`), own protocol (`yazcode://`), own version line, and the Zhipu subscription system fully removed. |

How yazcode works with its upstreams:

- Both upstreams are configured as git remotes (`zcode` → zai-org/ZCode, `zcodium` → ZCodium-project/ZCodium). Their changes are diff-audited before any risk-free ones are synced.
- Product-level decisions (data-directory rename, de-Zhipu work) stay **yazcode-only**; uncontroversial fixes and small features are still sent back to ZCodium as PRs.
- User data lives in `~/.yazcode` — migrated automatically on first run from legacy `~/.zcode` (official client) or `~/.zcodium` (early yazcode builds).

## What yazcode keeps

The product itself is unchanged — an AI coding workspace where a planning agent edits code, runs commands, verifies its own work and drives a real browser:

- **One Agent, three interfaces**: Electron desktop app, browser workspace and the `yazcode` terminal TUI share the same Agent runtime and sessions; SSH remote hosts and phone-browser remote control included.
- **Plans, edits, runs, verifies**: file changes arrive as diffs, terminal commands carry their context, and every edit/command/tool call can require approval — allow once, allow per project, or full access.
- **Multi-agent collaboration**: sub-agents, dynamic workflows, skills and scheduled automations.
- **Plugins, skills and MCP**: built-in skills plus a plugin system, each with its own switch.
- **Bring your own model**: presets for DeepSeek, OpenAI, Anthropic, Moonshot Kimi, MiniMax, Z.AI (GLM), Alibaba, xAI, Xiaomi MiMo and OpenRouter, plus fully custom endpoints (Chat Completions, Responses, Anthropic Messages). Custom providers can auto-detect their available models via the provider's `/models` endpoint.

## What yazcode removes and hardens

### Inherited from ZCodium

Compared with the upstream open-source release, this repository contains **no monitoring or telemetry implementation**:

| Area | Removed |
| ---- | ------- |
| Client monitoring SDK | Alibaba Cloud ARMS RUM (`@arms/rum-electron`), its patch, initialization, route instrumentation, renderer bridges |
| Usage and network telemetry | Network metric aggregation and reporting, API event ingestion, host/scheduler forwarding, remote-session usage sampling |
| Resource and performance | Periodic resource sampling, memory diagnostics, data-size stats, TTFT export, MCP telemetry |
| Crash collection | Crash dump reporting, OOM annotations, stability telemetry |
| CLI telemetry | The entire `@zcode/telemetry` package (OTLP export, model API recording, agent metrics and traces) |
| UI instrumentation | Session-open, subscription-error, automation, prompt-template and user-action instrumentation, plus platform reporting methods and IPC bridges |
| Protocol and configuration | Telemetry event protocols and reporting paths; legacy telemetry env vars cannot re-enter the agent |

**Kept on purpose**: local logs (troubleshooting), user-initiated feedback, and normal business requests (model calls, update checks). Removal reports per package: [desktop](packages/desktop/specs/telemetry-removal-report.md), [CLI](apps/zcode-cli/specs/telemetry-removal-report.md), [UI](packages/ui/specs/telemetry-removal-report.md).

### Added by yazcode

- **De-Zhipu**: the Zhipu subscription system (Coding Plan / Start Plan providers, `zhipu-account` access, first-run plan onboarding) is removed — Z.AI / BigModel remain as plain API-key presets, same as DeepSeek or Kimi. The official CDN builtin-config source is disabled; builtin providers come only from the audited `config/provider/zcode-builtin.json` in this repository.
- **Own identity and data directory**: user data lives in `~/.yazcode` (auto-migrated from legacy `~/.zcode` / `~/.zcodium`); env prefix `YAZCODE_*`; protocol `yazcode://`; CLI command `yazcode`.
- **Hard data-root boundary**: an explicit data-root env is a hard boundary — desktop bootstrap never falls back to reading the real HOME settings when it is set.
- **Model detection**: adding a model to a custom provider can query that provider's `/models` endpoint and fill in the model ID from the detected list.

## Install

The [Releases](https://github.com/yachen4ever/yazcode/releases) page ships desktop clients (macOS / Windows / Linux) and the CLI distribution.

**About signing**: the builds are **not signed by Z.ai**, so the OS blocks the first launch — that is expected. Verify the download against the `sha256.txt` on the release page first (`shasum -a 256` / `sha256sum` / `certutil -hashfile <file> SHA256`).

### macOS (.dmg)

1. Download `yazcode-*-mac-arm64.dmg` (Apple Silicon) or `yazcode-*-mac-x64.dmg` (Intel), open it and drag yazcode into Applications.
2. Gatekeeper will report an unverified developer. **After dragging into Applications**, run:

   ```bash
   # One-time command (unblocks and launches; it exits immediately):
   sudo /usr/bin/xattr -rd com.apple.quarantine "/Applications/yazcode.app" && open -a "yazcode"
   ```

   Alternatively: right-click the app in Finder → Open → Open again. Afterwards it launches normally.

### Windows (.exe)

1. Download `yazcode-*-win-x64.exe` and double-click it.
2. SmartScreen shows "Windows protected your PC" — click **More info** → **Run anyway** and finish the installer.

### Linux (.AppImage)

```bash
chmod +x yazcode-*-linux-x86_64.AppImage   # or the -arm64 build
./yazcode-*-linux-x86_64.AppImage
```

### CLI distribution (.tar.gz)

Self-contained bundle (TUI + Web + Agent), needs Node.js 24; the install script and runtime code are both in this repository:

```bash
tar -xzf yazcode-*.tar.gz && cd yazcode
./install.sh      # installs the yazcode command (defaults to ~/.yazcode/runtime, entry in ~/.local/bin)
yazcode --help
```

## Build from source

Requirements: Git, Node.js **24.14.0**, pnpm **10.33.2** — [mise.toml](mise.toml) is the source of truth (`mise install` sets both up).

```bash
pnpm install
pnpm dev:desktop                     # Electron desktop app
pnpm dev:web                         # Web client + server
pnpm --filter @zcode/cli dev         # Agent CLI / TUI
pnpm build:zcode                     # CLI distribution package
```

Releases are built by the [Release workflow](https://github.com/yachen4ever/yazcode/actions/workflows/release.yml) in this repository; every artifact comes from the audited source here.

## Versioning

yazcode uses its own version line starting at `1.0.0`, independent of the upstream `3.14.x` numbering:

- **y (minor) — upstream sync**: bumped when a release carries changes audited and synced from upstream. The exact upstream commits are recorded in that release's notes.
- **z (patch) — yazcode's own iteration**: bumped for yazcode-only features, fixes and product changes.
- Same-day rebuilds get an `-audit.<date>[.n]` suffix. Breaking changes (e.g. data-directory migrations) are called out in the release notes.

## Community

| Discord | QQ group |
| ------- | -------- |
| <img src="docs/community/discord-qr.png" alt="Discord invite QR code" width="220" /> | <img src="docs/community/qq-group-qr.jpg" alt="QQ group QR code" width="220" /> |
| https://discord.gg/HeDkhY9nV | Group ID: 344502652 |

## Disclaimer

This repository is community-driven open source (MIT) and is not affiliated with Z.ai or any commercial company. All facts come from public reporting and independent code audits, with sources cited — see [Background coverage](#background-coverage). If any party believes something is inaccurate, please open an issue.

## Background coverage

The audit work exists because of the monitoring and data-egress findings below; this repository makes no finding of fact beyond them:

| Source | Link |
| ------ | ---- |
| ferstar's original technical analysis | https://blog.ferstar.org/posts/zcode-silent-workspace-snapshot-upload/ |
| Independent reproduction | https://blog.margrop.net/post/zcode-silent-git-upload-investigation/ |
| Official open-source repository (upstream) | https://github.com/zai-org/ZCode |
| The Paper coverage | https://www.thepaper.cn/newsDetail_forward_34111815 |
| Jiemian News coverage | https://www.jiemian.com/article/15120609.html |
| ITHome coverage | https://www.ithome.com/1/005/046.htm |
| Huxiu coverage | https://www.huxiu.com/article/4892416.html |
| ifeng coverage | https://tech.ifeng.com/c/8waIS4X7FAe |

## License

[MIT](LICENSE) — inherited from the upstream open-source release.

The upstream [ZCode README](https://github.com/zai-org/ZCode#readme) describes the upstream project itself; its community links, services and commitments are maintained by Z.ai and are not part of this fork.

A similarly-named independent project exists at [axiom-desu/yazcode](https://github.com/axiom-desu/yazcode) — unrelated to this repository.
