# Spec：Provider 自定义请求头（api.headers）——会话占位符与保护头（26.5.10，issue #36）

## 背景

OpenCode Go（订阅制推理，经 debsvc new-api 网关渠道转发）要求客户端自报
`x-opencode-session`（每会话稳定 ID，用于上游路由与 prompt 缓存优化）。网关侧已
就位（渠道 `header_override` 含 `{client_header:x-opencode-session}` 占位符——客户端
带头即生效，网关零改动）。

现状盘点（代码级）：

- `api.headers`（静态自定义头）已支持：`provider-data-schema.ts` 的
  `headers: z.record(z.string(), z.string())` → `resolver.ts` 投到
  `resolved.headers` → `runner-options.ts` 的 `mergeRequestHeaders(provider,
  attribution)` 合并进 AI SDK 请求；
- `x-opencode-session` 自动注入仅覆盖官方域名（`isOpenCodeGoBaseUrl`：
  `opencode.ai/zen/go/v1`）——经 new-api 网关（自建 baseURL）时不注入；
- 缺口：headers 值无动态占位符，无法表达「每会话 sessionId」。

## 行为规则

### 1. 占位符 `{{sessionId}}`

- `api.headers` 的值中 `{{sessionId}}` 在合并进请求前替换为**当前会话 ID**；
- 取值口径与请求归因头一致：`normalizeModelSessionIdForAttribution`
  （strip `sess_` / `subagent_agent_` 内部前缀，内部实现前缀不外泄）；
- **每会话稳定**：同一会话的多次请求值相同（非每请求随机——prompt 缓存命中的
  前提）；不同会话不同；
- **未知占位符原样保留**（`{{foo}}` 不吞、不报错）；会话 ID 缺失时
  `{{sessionId}}` 亦原样保留（可观测，不产生空头值）；
- 静态值（无占位符）行为完全不变。

### 2. 保护头丢弃

以下 header 出现在 `api.headers` 时**丢弃并记录**（防误配破坏鉴权/传输栈；与
new-api 插件保护头名单对齐）：

`Authorization` / `Host` / `Content-Length` / `Content-Type` /
`Content-Encoding` / `Cookie`（大小写不敏感比较）。

丢弃为安全默认；告警经 runner 层既有 `Logger.warn` 输出（同一 header 名进程级
只告警一次，防每请求刷屏）。任务链路无 logger 时静默丢弃（安全性不变）。

### 3. 优先级（不变）

合并顺序 `{ ...providerHeaders, ...attributionHeaders }`：请求归因头
（`x-request-id` / `x-session-id` / `x-zcode-trace-id` / `x-zcode-session-type` /
`x-query-id`）覆盖 provider 同名配置——内部归因不可被配置覆盖。
`x-opencode-session` 不在归因自动集合之外的特殊处理：官方 URL 时归因自动注入
（与占位符值同源同值）；网关 URL 时归因不注入，provider 配置的占位符值生效。

## 验收

| 判据 | 看什么 |
| --- | --- |
| 占位符替换 | 单测：同会话两次解析值相同且 = strip 前缀后的会话 ID；不同会话不同 |
| 静态头不变 | 无占位符 headers 原样输出 |
| 未知占位符保留 | `{{foo}}` 原样输出；无会话 ID 时 `{{sessionId}}` 原样 |
| 保护头 | 配置 Authorization 等被丢弃且列表返回；大小写不敏感 |
| 官方 URL 回归 | `createModelRequestAttributionHeaders`：官方 URL 注入 `x-opencode-session`、网关 URL 不注入（新补单测锁定现状） |
| 端到端（mock） | 替换后的头值经 fetch 发到本地 mock server，服务端收到 = 会话 ID |
| 门禁 | typecheck / lint 0 errors（warnings ≤ 基线 95） |

## 配置示例

```json
"api": { "type": "anthropic-messages", "baseUrl": "http://192.168.5.7:3001", "headers": { "x-opencode-session": "{{sessionId}}" } }
```
