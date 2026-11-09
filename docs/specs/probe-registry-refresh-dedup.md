# Spec：探针链路前缀段优化——registry refresh 去重与 probe app 复用（26.5.8 引入，26.5.9 修正去重条件）

来源：issue #12 定界回执遗留 1（前缀段方差：S2 同步 RPC 内含一次 registry refresh +
S4 每探测无条件 refresh + S5 无活跃会话冷启 app 后即拆）。
**26.5.9 修正背景（issue #29，八轮误报与实测复盘的最终结论）**：26.5.8 的去重条件
仅凭「Host 已推送 account config」就跳过探测侧 refresh。该假设在 **Base URL
（personal config 侧）维度不成立**——推送路径的 refresh 可能发生在 personal 文件落盘
之前（保存/刷新竞态），跳过之后探测读到旧 Base URL。

> 澄清（#29 复盘）：八轮报告「保存后不再自动探测」中的「26.5.7 保存即探测」实为
> 对七轮报告的误读回溯（七轮原文的每次实测均包含点击「刷新」步骤；产品从未存在
> 「保存后自动探测」行为）。真实的确定缺陷是**保存+刷新竞态下探测读旧 personal
> config**，其形态与 m5air 代码定位一致，本 spec 按修正语义重写。

## 现状链路

```
Host: S2 ensureAccountProviderConfigSynced
        └─ syncAccountProviderConfigToClient（按 account revision 去重推送）
             └─ CLI 接收 handler: syncAccountProviderConfig
                  └─ registryService.refresh("host-account-config")   ← 刷新 A
CLI: S4 testProviderModelConnectivity
        └─ registryService.refresh("provider-connectivity")          ← 刷新 B
     S5 active?.app ?? probe app 缓存（26.5.8 引入）
```

- `registryService.refresh` 是**全量读**（config 源 = builtin + personal，account 源）；
- 保存 Base URL → personal 文件原子落盘 → config 源 onDidChange → account 源 resolve
  可能随 revision 变化触发刷新 A；但刷新 A 与文件落盘的先后顺序不确定；
- S4 的无条件 refresh 是保命语义：旧 Personal Config 跨进程 watcher 可能漏掉原子写
  事件，探测必须先刷新才能看到用户刚保存的端点编辑（**不可删除，只能有条件跳过**）。

## 行为规则（26.5.9 修正后）

### 1. registry refresh 去重：双条件收紧

`providerTestModelConnectivity` RPC params 的可选字段 `accountConfigPushed` 保留，
但**只有同时满足**才跳过探测侧刷新 B：

1. `accountConfigPushed === true`（Host 本探测前确实推送了 account config，刷新 A
   已在接收 handler 内完成）；
2. **CLI 侧自证**「最近一次 registry refresh 已完成于当前 config 源状态之后」
   （`registry-refresh-freshness`：config 源每次 onDidChange 让 epoch +1，refresh
   完成时记录已覆盖 epoch，比较相等才算新鲜）。

任一不满足、或自证能力未装配（旧 CLI/测试嵌入）→ **照旧执行刷新 B**——fail-open
永远落在「多刷新一次」的安全侧。

- 保存+刷新竞态场景（26.5.8 退化形态）：保存落盘触发 config 源变更 → 刷新 A 先于
  该变更完成 → epoch 不相等 → 刷新 B 执行 → 探测读**新** Base URL ✓；
- 无 personal 变更的推送场景：刷新 A 后 config 源无变化 → epoch 相等 → 跳过刷新 B
  → 每探测 registry refresh 次数从 2（26.5.7：推送刷新 + 探测刷新）降到 **1** ✓；
- 未推送场景（revision 未变）：与 26.5.7 相同，探测侧照旧刷新（watcher 漏事件防线）✓。

### 2. probe app 复用（26.5.8 引入，保持）

无活跃会话的探测 app 按工作区键缓存（in-flight 去重 + TTL 60s + checked-out 防长探测
被打断 + 身份核对防误删）；app 探针选择读共享 registry 调用时活视图，刷新后天然新鲜；
有活跃会话仍优先会话 app。本项与去重解耦——即使去重条件收紧，app 复用收益（冷启
~0.4-0.5s/次）不受影响。

### 3. 硬约束不变量（两版一致）

- 探测仍**真发请求**到 provider（fail-closed 三方判定与 10s Single 档不变）；
- 凭据边界不变（known_hosts 只存指纹、凭据不入盘不入日志）；
- **不得为省时间跳过探测**（跳过刷新的条件必须自证覆盖，且永不跳过探测本身）。

## 验收

- **A**：保存 Base URL 后点刷新（或 26.5.7 时代的等价位序列）→ 状态点/失败 toast
  反映**新** Base URL 的判定（保存+刷新竞态不再读旧值）；
- **B**：推送场景下 registry 刷新计数 2（26.5.7）→ 1（26.5.9）；连续纯刷新场景
  维持 1（不变）；给出计数对比；
- **C**：pushed=false 路径（watcher 漏事件防线）照旧自刷新，行为不变；
- **D**：本 spec 即 D 项交付（修正后语义）；实现含 `registry-refresh-freshness`
  单测 4 例 + 探测侧 skip/refresh 矩阵 3 例（pushed×自证）回归守卫。
