# 仓库导航

这份文档只做一件事：**告诉你某个问题该跑哪条命令、或该读哪份 spec。**

它不解释实现。原因是实现会变，而这份文档不会跟着变——见下方「为什么这里没有实现说明」。

## 使用方式

从「我要回答什么问题」进入，不要从「我要读哪个模块」进入。

| 我想知道… | 跑这条 / 读这份 |
| --- | --- |
| 某个模块的归属、依赖方向、公开入口 | `pnpm architecture:context <module-id>` |
| 改动会不会违反架构约束 | `pnpm architecture:check --changed` |
| 某个 export 被谁引用、能不能删 | `pnpm dep:refs <file>:<exportName>` |
| 这个文件导出了什么 | `pnpm dep:refs --list-exports <file>` |
| 有没有没用到的依赖或导出 | `pnpm knip` |
| 某项**契约**为什么是这样 | 下方「规格索引」 |
| 提交前的完整门禁 | `pnpm verify:pre-push` |

## 模块阅读包

```bash
pnpm architecture:context <module-id>
```

从 `architecture-policy.yaml`（唯一真源）读模块声明，再结合磁盘上真实存在的文件，输出受控上下文：owner、managed、requires、文件清单、契约文件路径、上游依赖的契约。**它是生成的，因此不会与代码不一致。**

当前 15 个 module-id：

| id | 路径 | managed |
| --- | --- | --- |
| `rpc` | `packages/rpc/src` | false |
| `shared` | `packages/shared/src` | false |
| `provider` | `packages/provider/src` | false |
| `provider-node` | `packages/provider-node/src` | false |
| `services` | `packages/services/src` | false |
| `session` | `packages/services/src/session` | false |
| `storage` | `packages/services/src/storage` | **true** |
| `client` | `packages/client/src` | false |
| `server` | `packages/server/src` | false |
| `zcode-server-cli` | `packages/zcode-server-cli/src` | false |
| `ui` | `packages/ui/src` | false |
| `web` | `packages/web/src` | false |
| `desktop` | `packages/desktop/src` | false |
| `formal-proof` | `packages/formal-proof/src` | false |
| `zcode-cli` | `apps/zcode-cli` | false |

### 一个容易误读的地方

`architecture-policy.yaml` 里 `global.managedOnly: true`，而**当前只有 `storage` 一个模块是 `managed: true`**。所以 `architecture:check` 通过，含义是「`storage` 的边界没问题、且没有任何模块引入新违规」，**不等于** 15 个模块的边界都已被强制执行。其余 14 个是 `managed: false` 的存量模块，声明已登记、约束未开启。

要不要把某个模块转成 `managed: true`（开启强制），是逐模块的决策，不在这份文档范围内。

### 约束阈值

来自 `architecture-policy.yaml` 的 `global`，同样以该文件为准：

```
maxFileLines: 400        maxContractLines: 300
maxPublicMethods: 12     forbidCycles: true
forbidDeepImports: true  managedOnly: true
```

## 规格索引

spec 记录的是**契约与不变量**——「必须被记住的规则」，不是「代码现在怎么写的」。AGENTS.md 要求行为改动同步更新对应 spec，这是 spec 的维护约定。

### 遥测与官方平台（产品立场类）

| spec | 回答什么 |
| --- | --- |
| `packages/desktop/specs/no-telemetry.md` | 桌面端无遥测的边界 |
| `packages/desktop/specs/telemetry-removal-report.md` | 桌面遥测移除报告 |
| `packages/ui/specs/no-telemetry.md` | UI、平台与 Server 移除遥测 |
| `packages/ui/specs/telemetry-removal-report.md` | UI / Shared / Server 遥测清理报告 |
| `apps/zcode-cli/specs/no-telemetry.md` | Open Audit CLI 遥测删除边界 |
| `apps/zcode-cli/specs/telemetry-removal-report.md` | CLI 与共享层遥测移除报告 |
| `packages/desktop/specs/no-official-platform.md` | 官方平台断连 |
| `packages/desktop/specs/no-official-platform-report.md` | 官方平台断连报告 |

### 命名与数据根（改名前必读）

| spec | 回答什么 |
| --- | --- |
| `docs/specs/p0-user-facing-naming.md` | P0 用户可见命名统一（zcode → yazcode） |
| `docs/specs/p1a-external-env-renames.md` | 对外环境变量改名 `ZCODE_` → `YAZCODE_`（旧名兼容一版） |
| `docs/specs/zcodium-data-root.md` | 数据根目录更名 `.zcode` → `.yazcode` 与一次性迁移 |
| `docs/specs/flatten-provider-zones.md` | 移除智谱套餐体系，Provider 拉平为普通预设 |

### Provider 与外部服务

| spec | 回答什么 |
| --- | --- |
| `docs/specs/model-provider-remote-model-detection.md` | 自定义 Provider 的可用模型自动检测 |
| `packages/services/specs/provider-balance-query.md` | 外部 API Key Provider 余额查询 |
| `packages/services/specs/official-service-switches.md` | 官方服务开关的持久化与进程投影 |

### 运行时与发布

| spec | 回答什么 |
| --- | --- |
| `packages/desktop/specs/remote-assets-github-release.md` | 远程资源 `zz-*` 资产的命名契约与自建源加载 |
| `packages/desktop/specs/github-updates.md` | 桌面更新 |
| `packages/desktop/specs/macos-dmg-installation.md` | macOS DMG 安装体验 |
| `docs/specs/dev-data-dir-isolation.md` | 开发/E2E 运行的数据目录隔离硬边界 |
| `.agents/specs/bots-astrbot-bridge.md` | 机器人 AstrBot 桥接协议 v2 |

## 可执行门禁（规则的代码形态）

下面这些约束已经写成会失败的检查，而不是写成文字。**改代码前先看它们，比读文档可靠。**

| 门禁 | 位置 | 拦什么 |
| --- | --- | --- |
| `verify:pre-push` | `package.json` | `lint` + `architecture:check --changed` |
| `architecture:check` | `scripts/architecture/` | 模块边界、文件行数、公开方法数、循环依赖、深层导入 |
| `licenses-notices` | `.github/workflows/licenses-notices.yml` | 许可台账与实际依赖树漂移；许可标识越界 |
| `release` | `.github/workflows/release.yml` | 任一平台产物缺失则 release 保持 draft |
| `upstream-audit` | `.github/workflows/upstream-audit.yml` | 上游同步的增量审计 |

`licenses-notices` 值得单独说明：它会重生成 `THIRD-PARTY-NOTICES.md` 与 `third-party/inventory.json`，并要求结果与已入库版本逐字节一致；不一致即失败。**这台闸门必须在 Linux 上跑**，脚本校验的是磁盘上真实安装的依赖树，而依赖树含平台相关的 optional 依赖——在 Windows 或 macOS 上重生成会得到不同结果。因此**不要在本地重生成这两份文件**，改完依赖后手动 dispatch 一次工作流，把 artifact 下载下来提交。

## 为什么这里没有实现说明

一份「zcode 各模块是怎么实现的」的文档，会在第一次改动之后就开始撒谎。而过期的实现文档比没有更糟：读者会信任它，于是它安静地误导人。

这份仓库里已经有一份现成的教训：`THIRD-PARTY-NOTICES.md` 的输入哈希曾经记录的是一份仓库中并不存在的文件，而当时并没有任何文字发现这个问题——是 `licenses-notices` 闸门在 push 时把它验出来的。**能被执行的约束，就不要写成说明。**

所以这份文档只保留两类内容：

1. **指针**——命令与文件路径，每条都能当场跑一下自证真伪；
2. **约定**——spec 索引，以及各门禁拦什么。

## 这份文档自己的维护规则

- 只写**当场可验证**的命令与路径，不写实现描述。
- 新增模块 / 新增 spec 时，同步补进上面两张表。
- **发现指针失效就是 bug，直接修。** 一个跑不通的命令比一个空章节更有害，因为它会让人误以为那里没有东西。
- 若某条内容无法用命令或路径验证，它就不属于这份文档——该写进 spec（如果是契约），或改成门禁（如果能自动判定）。
