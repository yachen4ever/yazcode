# Spec：探针链路前缀段优化——registry refresh 去重与 probe app 复用（26.5.8 修复项 ①）

来源：issue #12 定界回执遗留 1（y430p 分段测量：S2 同步 RPC 内含一次 registry
refresh + S4 每探测无条件 refresh + S5 无活跃会话时每探测冷启 app 后即拆——
0.5s 量级的前缀段方差）。

## 现状与语义盘点

一次 `testModelConnectivity`（UI 探针 / agent 侧同一能力）的前缀段：

```
Host: S2 ensureAccountProviderConfigSynced
        └─ syncAccountProviderConfigToClient
             ├─ revision 未变 → 跳过推送（无刷新）
             └─ revision 变了/首轮 → push RPC providerUpdateAccountConfig
                  └─ CLI 接收 handler: syncAccountProviderConfig
                       └─ registryService.refresh("host-account-config")   ← 刷新 A（总是发生，含 changed=false）
CLI: S4 testProviderModelConnectivity
        └─ registryService.refresh("provider-connectivity")               ← 刷新 B（无条件）
     S5 active?.app ?? createWorkspaceZCodeApp(...); finally close(!active)
```

- S4 的无条件 refresh 是**保命语义**：旧 Personal Config 跨进程 watcher 可能漏掉
  原子写事件，探测必须先刷新才能看到用户刚保存的端点编辑（不可删除）；
- 刷新 A 与 B 作用于**同一个 registryService**，同一次探测内背靠背发生时是重复功；
- S5 的冷启+即拆发生在「无活跃会话」时——设置页探针正是该形态，连续刷新被反复
  冷启付费。

## 行为规则

### 1. registry refresh 去重（契约面）

`providerTestModelConnectivity` RPC params 新增**可选**字段
`accountConfigPushed?: boolean`（缺省/缺字段 = false）：

- **pushed=true**（host 在本次探测内实际推送了 account config，CLI 接收 handler
  已执行刷新 A）→ CLI handler **跳过刷新 B**——同一次探测的 registry refresh 恰好
  一次；
- **pushed=false / 缺省**（revision 未变，host 未推送）→ CLI handler **照旧执行
  刷新 B**——保住 personal config watcher 漏事件防线；
- **fail-open 方向**：旧 CLI 忽略新字段（照旧刷新）、旧 Host 不带字段（CLI 照旧
  刷新）——缺省永远落在「多刷新一次」的安全侧，不会落在「跳过刷新」侧；
- 语义不变量：探测仍**真发请求**到 provider；fail-closed 三方判定与 10s Single
  档上限不变；凭据边界不变。

### 2. probe app 复用（CLI 内部，无契约面）

`testProviderModelConnectivity` 无活跃会话时创建的 app 由「即拆」改为「按工作区
键缓存复用」：

- **键** = `workspace.workspaceKey`（workspacePath/identity 已含在键语义内）；
- **in-flight 去重**：同键并发探测共享同一次创建（后到者等前者物化）；
- **TTL**：最后一次使用后 60s 关闭并出缓存（timer 恒生效，连接断开也只延迟关闭
  ≤60s，进程退出由 OS 兜底）；
- **新鲜度**：app 的探针选择绑定读共享 registry 的**调用时活视图**
  （session-facade `completeAuxiliaryRegistryModelSelection`），刷新后的 registry
  对缓存 app 立即可见——复用不影响「探测看到最新配置」；
- **优先级**：有活跃会话时仍优先 `active.app`（缓存条目闲置到期自然出清）；
- app 实例的关闭语义（`app.close?.()`）不变，只是从「每探测一次」变为「TTL 到期
  一次」。

## 验收

1. 首轮探测（host 推送）→ registry refresh 恰一次（push handler 内），探测 RPC
   携带 `accountConfigPushed: true` 且 handler 跳过刷新 B；
2. 重复探测（revision 未变）→ 刷新 B 照旧执行；
3. 无活跃会话连续两次探测 → 第二次复用缓存 app（`createZCodeApp` 只调一次），
   TTL 到期后 `app.close` 恰一次；
4. 时延端到端对比（拒绝档 127.0.0.1:9，10 样本）不劣化失败判定；
5. 既有单测（retry-budget 档位等）不回退。
