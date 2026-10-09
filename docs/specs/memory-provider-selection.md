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

| provider | 记忆写入 | 记忆检索与注入 | OpenViking 集成 hooks | `openviking_*` MCP |
|---|---|---|---|---|
| `disable` | 无 | 无 | 不装载 | 不注册 |
| `local` | extraction 子代理 | `MEMORY.md` 全文注入 | 不装载 | 不注册 |
| `openviking` | OV Stop 捕获 + 服务端抽取 | OV `UserPromptSubmit` 语义召回 | 装载 4 事件 | 注册 20 工具 |

核心约束：

1. **`local` 与 `openviking` 完全互斥**，不存在「本地记忆 + OV 压缩」的组合。将来若实现压缩接管（`compactionProvider` 抽象），那是与本维度独立的第二个字段，不复用本枚举。
2. **不兜底**。`openviking` 档位下 OV 不可达时，**不回落到 local**，而是显式报错。理由：静默降级会让用户以为 OV 生效，实际召回来源已变，行为不可预测且难以排查。
3. **切换不删数据**。三种状态切换只改注入来源，不清理任何一方的存量：`local` 的记忆留在数据根 `cli/memories/`，`openviking` 的记忆留在服务端。误切后可切回取回。
4. **状态一致性**：`openviking_*` MCP 工具与集成 hooks 同属 `openviking` 档位，二者必须同进同出，不允许「hooks 装载但工具缺失」这类半开状态。
5. **连接校验前置**。用户在设置里选定 `openviking` 并提交 url/user key 时，必须先完成连通性与鉴权校验，未通过则当场阻止保存并给出可诊断原因，不允许把失败推迟到开会话时才暴露。

### 连接校验的错误分类

| 情形 | 判定 | 提示要点 |
|---|---|---|
| 地址不通 | 网络层失败 | 服务地址、网络可达性 |
| 非 OV 服务 | `/health` 非 OV 响应 | 该端口未运行 OpenViking |
| 鉴权失败 | 401/403，或 root key 被数据面拒绝 | 必须是 **user key**；root key 仅管理面 |

### 迁移

存量设置中 `memoryEnabled: true` 一律映射为 `local`，`false` 映射为 `disable`。映射只发生一次，读到存量形状时归一化后写回新字段。

## 状态所有者

- **取值定义与归一化**：`packages/shared`（设置 schema 唯一 owner）。
- **`local` 档位的启用判定**：`apps/zcode-cli/packages/core/src/runtime/helpers/project-memory.ts` 的 `resolveEnabledProjectMemoryRoot()` —— 这是内置记忆层唯一的开关点，改为仅 `local` 返回非空。阈值策略、cut point、注入位置一律不动。
- **集成运行时与配置写入**：`packages/services` 承担安装/卸载/校验；运行时（hooks + MCP proxy）落在 `OPENVIKING_HOME/agent-integrations/`，随发行包 vendored。
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