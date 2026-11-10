# Spec：记忆提供方三态选择（disable / local / openviking）

## 背景

现有记忆层只有 `memoryEnabled` 一个布尔开关，且只能表达「内置文件记忆 开/关」。实测该层的能力边界是：

- **注入**：会话启动时把 `MEMORY.md` **全文**塞进 meta_user 段（上限 200 行 / 25k 字符），无 embedding、无 top-k、无按 query 过滤；
- **写入**：成功的 main turn 结束后调度 extraction 子代理（`runMemoryAgentLoop`，maxTurns=5）用通用 `Write`/`Edit` 工具写 `.md`；
- **检索**：**不存在**。模型自己 `Read`/`Grep` 拉细节；
- **抽取模型**：复用会话主模型。

工作负载实测暴露两个问题：

1. **检索缺失导致穷举**：一个 1359 消息、1104 次模型请求的会话派生了 3 个子代理，**全部用于 grep 知识库**。把知识分册导入 OpenViking 后，同类查询（"拆机审批走哪个流程"）由语义召回一次命中（score 0.82，返回 `viking://` URI 供二次展开）。
2. **全文注入无压缩**：该会话单轮上下文峰值 **780,092 token**，1104 轮里 **676 轮（61%）** 超过 yazcode 的自动压缩阈值（166,000），但 `MEMORY.md` 的 25k 字符每轮都在，**从不参与任何裁剪**。

同时 OpenViking 服务端侧已就绪（自建 + VLM 抽取模型 M3.1 + embedding 1024 维），客户端集成经实测验证：自动召回、MCP 20 工具、Stop 捕获落库三者全通。

## 行为规则

`memoryEnabled: boolean` 改为 `memoryProvider: "disable" | "local" | "openviking"`，取值互斥、**无兜底**：

| provider     | 记忆写入                  | 记忆检索与注入                 | OpenViking 集成 hooks | `openviking_*` MCP |
| ------------ | ------------------------- | ------------------------------ | --------------------- | ------------------ |
| `disable`    | 无                        | 无                             | 不装载                | 不注册             |
| `local`      | extraction 子代理         | `MEMORY.md` 全文注入           | 不装载                | 不注册             |
| `openviking` | OV Stop 捕获 + 服务端抽取 | OV `UserPromptSubmit` 语义召回 | 装载 4 事件           | 注册 20 工具       |

核心约束：

1. **`local` 与 `openviking` 完全互斥**，不存在「本地记忆 + OV 压缩」的组合。将来若实现压缩接管（`compactionProvider` 抽象），那是与本维度独立的第二个字段，不复用本枚举。
2. **不兜底**。`openviking` 档位下 OV 不可达时，**不回落到 local**，而是显式报错。理由：静默降级会让用户以为 OV 生效，实际召回来源已变，行为不可预测且难以排查。
3. **切换不删数据**。三种状态切换只改注入来源，不清理任何一方的存量：`local` 的记忆留在数据根 `cli/memories/`，`openviking` 的记忆留在服务端。误切后可切回取回。
4. **状态一致性**：`openviking_*` MCP 工具与集成 hooks 同属 `openviking` 档位，二者必须同进同出，不允许「hooks 装载但工具缺失」这类半开状态。
5. **连接校验前置**。用户在设置里选定 `openviking` 并提交 url/user key 时，必须先完成连通性与鉴权校验，未通过则当场阻止保存并给出可诊断原因，不允许把失败推迟到开会话时才暴露。

### 连接校验的错误分类

| 情形                                         | 判定（reason）   | 提示要点                               |
| -------------------------------------------- | ---------------- | -------------------------------------- |
| 地址不通（含数据面网络失败）                 | `unreachable`    | 服务地址、网络可达性                   |
| 鉴权失败（key 缺失 / 401/403，含数据面被拒） | `unauthorized`   | 必须是 **user key**；root key 仅管理面 |
| 服务端错误（非 2xx）                         | `server_error`   | 服务返回状态码原文                     |
| `/health` 非 OV 响应                         | `not_openviking` | 该端口未运行 OpenViking                |

校验在 `/health` 之外**额外打一次数据面请求**确认 user key 真能读——`/health` 是
公开端点，只信它会漏掉「服务在但 key 无效」；数据面失败按其性质归入
`unreachable` / `unauthorized`，不设独立类别。

### MCP 代理拉起契约与安装期握手自检

2026-10-25 workwin 事故（hooks 正常、`openviking_*` MCP 全断、模型因找不到工具空转
「占位」调用）确立两条安装器契约：

1. **command 必须能以 node 语义执行 `mcp-proxy.mjs`**。桌面宿主是 Electron 应用：
   写入 `process.execPath` 作为 MCP stdio command 时，**必须同时写
   `env.ELECTRON_RUN_AS_NODE = "1"`**——否则子进程启动的是应用 GUI 本体（stdout 混入
   应用日志、无 JSON-RPC 响应、单实例合入后退出，宿主侧表现为 `Connection closed`）。
   禁止把宿主可执行文件裸写为 command（历史遗留配置曾写 `python.exe`，同样跑不了
   `.mjs`——「宿主二进制能当 node 用」从来不是成立假设）。
2. **安装写盘后必须用最终落盘的 command+args+env 真做一次 MCP 握手自检**
   （`initialize` → `notifications/initialized` → `tools/list`，超时约 12s）。握手失败
   即**回滚本次写入的 CLI 配置**并显式报错，不得留下「配置已写、代理拉不起」的半开
   态——该半开态正是核心约束 4 禁止的「hooks 装载但工具缺失」，且能存活数天不被发现。

### 运行时来源与启动对账（26.5.9）

**运行时唯一来源 = 发行包内置**（`<resources>/openviking`；dev 为仓库 `vendor/openviking`），
不再复制到 `OPENVIKING_HOME/agent-integrations/`。理由：vendored 副本带有 yazcode 侧适配，
官方安装器不认识 yazcode；共用目录会被官方重跑覆盖，且「仅安装时释放」导致升级后运行时
版本漂移（实测：包内 0.5.29、运行时停在 0.5.23）。

1. **零复制**：`install()` 不再释放运行时副本；hooks 命令与 MCP server 直接指向包内绝对
   路径（`<root>/zcode/scripts/hook.mjs`、`<root>/zcode/servers/mcp-proxy.mjs`）。
2. **启动幂等对账**（`reconcileStartup()`，host 启动时触发）：仅当 CLI 配置存在
   `openviking` 段时动作——段内指向的插件根 ≠ 当前包路径则重写为包内路径；未启用时
   no-op；包内运行时缺失时 `warn` 且不改配置（fail-closed，宁可保留旧配置也不指向坏路径）。
   对账不握手（启动期不引入子进程自检），握手自检仍由 `install()` 承担。
   该对账同时是升级/换安装目录后的自愈路径与被官方安装器改写后的自愈路径。
3. **`uninstall()` 仅移除 CLI 配置段**（hooks 事件组 + MCP 条目），不删除任何目录：
   `OPENVIKING_HOME/agent-integrations/` 归官方安装器域，yazcode 不写不删；`ovcli.conf`
   等凭据文件保留原位。
4. **`getStatus()` 的 installed 判定 = 包内运行时存在 且 CLI 配置指向当前包路径**；
   `version` 读包内 `hosts/zcode/openviking.integration.json` 的 version（与 vendored
   版本锚点一致），`source` 恒为 `packaged`。
5. **状态所有者不变**：`packages/services` 仍是安装/卸载/校验/对账的唯一 owner；CLI 配置
   是落盘事实，UI 只经服务读状态。

### 迁移

存量设置中 `memoryEnabled: true` 一律映射为 `local`，`false` 映射为 `disable`。映射只发生一次，读到存量形状时归一化后写回新字段。

## 状态所有者

- **取值定义与归一化**：`packages/shared`（设置 schema 唯一 owner）。
- **`local` 档位的启用判定**：`apps/zcode-cli/packages/core/src/runtime/helpers/project-memory.ts` 的 `resolveEnabledProjectMemoryRoot()` —— 这是内置记忆层唯一的开关点，改为仅 `local` 返回非空。阈值策略、cut point、注入位置一律不动。
- **集成运行时与配置写入**：`packages/services` 承担安装/卸载/校验与启动对账；运行时
  （hooks + MCP proxy）直接取自发行包内置 `resources/openviking`（dev: `vendor/openviking`），
  不再复制到 `OPENVIKING_HOME/agent-integrations/`（该目录归官方安装器域，yazcode 不写不删）。
- **数据目录**：沿用现有数据根解析，本 spec 不引入新的目录概念。

## 不在本 spec 范围

- 压缩接管（`CompactSummaryProvider` 抽象 + OV 摘要来源）。它是独立维度，风险最高（OV 输出长度不受控、缺压缩路径回归测试），待记忆接管稳定后另行立项。
- `internal` 命名：已确认使用 `local`，语义即「本地文件记忆」，未来不承载第二种语义。

## 验收场景

1. `disable`：不启动 extraction 子代理，`MEMORY.md` 不注入，`openviking_*` 工具不出现在工具列表。
2. `local`：extraction 正常调度，`MEMORY.md` 按现有上限注入，工具列表无 `openviking_*`。
3. `openviking`：`local` 档位行为全部关闭；`UserPromptSubmit` 注入 OV 召回结果；工具列表出现 20 个 `openviking_*`；Stop 后服务端产生 `zc-<sessionId>` 会话。
4. `openviking` + 服务不可达：会话可开，但界面显式报错说明 OV 不可达，**不得**出现 `MEMORY.md` 注入。
5. 切换 provider 前后，原有记忆数据均未被删除。
6. 存量 `memoryEnabled: true/false` 的设置加载后归一化为 `local`/`disable`，且不报错。
7. 升级或安装目录变更后启动：CLI 配置的 openviking hooks/MCP 自动指向当前包内路径（启动对账）。
8. 官方安装器重写 CLI 配置后，yazcode 下次启动自动指回包内运行时，不需要用户重新安装。
9. `uninstall()` 后 `OPENVIKING_HOME/agent-integrations/` 目录原样保留，仅 CLI 配置段被移除。
10. 包内运行时缺失（打包异常）时：`getStatus()` 报未安装、`install()` 显式报错、启动对账
    不改动既有配置。
