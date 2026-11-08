# Spec：SSH 远端连接加固——主机密钥 TOFU 校验（26.5.7 修复批）

> **移植来源**：axiom-desu/ZCodium（Apache-2.0）commit
> [`1575a7696eaacccb2e05a86d071212b94013dedc`](https://github.com/axiom-desu/ZCodium/commit/1575a7696eaacccb2e05a86d071212b94013dedc)
> （2026-10-09，"SSH 连接启用主机密钥 TOFU 校验"）。移植文件与许可登记见
> `third-party/inventory.json` 的 `axiom-zcodium` 条目。上游 spec 原文为该仓
> `.agents/specs/ssh-remote-hardening.md` 缺陷 1；本文件按本仓 spec 口径改写并登记
> 适配差异。上游调研出处：`docs/upstream-port-tasks-20261108.md` §C1（issue #13）。

## 背景与威胁

`packages/server/src/remote/sshAuth.ts` 的 `buildSSHConnectConfig()` 构造 ssh2
`ConnectConfig` 时未设置 `hostVerifier`——ssh2 在缺省时接受**任意**主机密钥，即连接
不对服务端身份做任何校验。中间人可冒充目标主机完成密钥交换，用户输入的密码 / 私钥
口令会直接交给冒充者；而 SSH 远端正是会执行任意命令的 Agent 部署链路。本仓 `hostVerifier`
在全 `packages/` 下检索为 0 命中（移植前）。

**概念澄清（与既有机制的关系）**：`packages/shared/src/remoteSshHostKey.ts` 的
`buildSshRemoteHostKey()` 是**连接身份键**（host:port:username:认证方式:私钥路径的
JSON，供 UI 识别同一远程目标 / 跨窗口共享键），**不是主机密钥信任**。TOFU 是全新能力：
存储键复用身份键（两者命名互相指明，避免误读），但语义上是两回事。

## 行为规则

1. **TOFU 三方判定**（`SSHHostKeyStore.verify`，判定键 = `buildSshRemoteHostKey(target)`）：
   - 无记录 → 接受并落库（首次连接，`first-use`）；
   - 记录匹配 → 接受并刷新 `lastSeenAt`（`match`；刷新写失败不影响安全判定，连接继续）；
   - 指纹不一致 → 拒绝（`reject/changed`），**不覆盖**已有记录、不静默重连；
   - 存储任何故障（读取 / 解析 / schema 不兼容 / 写入）→ **fail-closed 拒绝**
     （`reject/store-error`），含首连记录写不进去——TOFU 的价值全在「下次能发现变更」，
     写不进去等于静默失去保护，不得放行。
2. **凭据边界**：known_hosts 只存 sha256 主机公钥指纹 + 时间戳；存储键沿用
   `buildSshRemoteHostKey()`（已刻意排除密码与私钥口令）；落盘内容经测试断言不含任何
   凭据；错误消息只带路径与原因摘要（指纹前 16 位），不回显凭据。
3. **降级语义**：known_hosts 缺失 → 空表（等价全部首连）；损坏 / schema 不兼容 →
   fail-closed 拒绝并提示路径，**不得静默清空重建**（那会把「密钥变更」伪装成「首次
   连接」）；写入故障 → 拒绝并带可操作原因（通常是配置目录权限）。
4. **拒绝原因可区分**：ssh2 对 `verify(false)` 只抛固定文案
   `Host denied (verification failed)`——verifier 在回调 `verify(false)` 前先经
   `onRejection` 记录 `changed`（安全事件）或 `store-error`（环境故障），ssh-backend 的
   `onClientError` 优先把它换成可操作的产品错误；`normalizeSSHConnectError` 的 host
   denied 兜底文案只说「校验未通过」，不断言密钥变更（那需要 verifier 的证据）。
5. **无逃生开关**：不提供「跳过校验」选项；正式连接链路必须注入 hostVerifier。
   `sshConfigAlias` 只用于 VSCode remote authority 字符串，不进入 ssh2 连接链路，
   不参与存储键。
6. **原子落盘**：先写 `.part` 再 rename——多窗口并发首连同一目标时不留半写 JSON。

## 状态所有者

| 状态                          | 所有者                                                                            | 说明                                                                   |
| ----------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| known_hosts（主机密钥指纹表） | 文件系统：`getAppConfigDir()/ssh/known-hosts.json`（`<数据根>/.yazcode/v2/ssh/`） | `SSHHostKeyStore` 唯一读写者；进程内缓存 + 原子替换写；schemaVersion 1 |
| 连接拒绝原因（本次连接尝试）  | `SSHBackend.hostKeyRejection` 实例字段                                            | verifier 回调写入、onClientError 消费；连接级生命周期                  |

事件顺序（一次 SSH 连接）：

```
SSHBackend.connect(options)
  1. createSSHHostVerifier({ store, target, onRejection }) → buildSSHConnectConfig 注入
  2. ssh2 密钥交换 → hostVerifier(key, verify)
  3. store.verify(target, sha256(key)) → first-use（落库）/ match / reject
  4. reject：onRejection 记录原因 → verify(false) → ssh2 抛 Host denied
     → onClientError 优先换 formatHostKeyRejectionError → 用户可读错误
```

## 接口

- `packages/server/src/remote/sshKnownHosts.ts`：`SSHHostKeyStore`（`verify`）、
  `createSSHHostVerifier`、`formatHostKeyRejectionError`、`getSSHKnownHostsPath`、
  `computeHostKeyFingerprint`。
- `sshAuth.ts`：`buildSSHConnectConfig` 新增 `hostVerifier` 入参；`normalizeSSHConnectError`
  增加 host denied 兜底。
- `ssh-backend.ts`：构造期注入 store + verifier；`onClientError` 优先换产品错误。
- 类型依赖（本仓已在）：`@zcode/shared` 的 `buildSshRemoteHostKey` / `SSHConnectOptions`；
  `@zcode/services/node` 的 `getAppConfigDir`。

## 验收场景

1. **三方判定**：首连接受落库（记录含算法与指纹）→ 匹配放行 → 指纹不一致拒绝且不覆盖记录。
2. **凭据边界**：仅密码不同的同一主机共享判定；落盘原文不含任何凭据。
3. **fail-closed**：known_hosts 损坏 / schema 不兼容 → `store-error` 拒绝且不重建；
   首连写入失败 → 拒绝。
4. **verifier 回调顺序**：首连 `verify(true)` 且无拒绝记录；变更先记录 `changed` 再
   `verify(false)`。
5. **错误文案区分**：changed 带「中间人」语义与清理路径；store-error 带环境原因、
   不谎称密钥变更。
6. **接线**：`buildSSHConnectConfig` 透传 hostVerifier；host denied 兜底文案；其余 SSH
   错误文案不受影响。

## 明确不做（本轮）

- 首连的信息性 UI 提示与密钥变更的阻断式确认弹窗（安全判定已闭环，展示层后续）；
- known_hosts 的 host 级删除 / 重置 UI（当前由用户按错误提示手工清理文件）；
- 上游 spec 缺陷 2（跨窗口并发部署的远端锁）——独立事项，不在本批。

## 移植适配点（相对上游 1575a769）

1. spec：上游 `.agents/specs/` → 本仓 `docs/specs/`，按本仓 spec 口径改写（状态所有者表 /
   事件顺序 / 验收场景），只引入缺陷 1；
2. 存储路径注释：上游 `<数据根>/.zcodium-exp/v2/ssh/` → 本仓 `<数据根>/.yazcode/v2/ssh/`
   （`getAppConfigDir` 语义一致）；
3. 测试：上游 vitest → 本仓 node:test+assert（DMG 移植同款转换），落
   `packages/desktop/test/`（server 包无测试设施，经公开面
   `@zcode/server/remote/*.js` 导入被测件）；
4. 代码本体（sshKnownHosts.ts / sshAuth 接线 / ssh-backend 注入）与上游语义逐条一致，
   仅注释与来源标注适配。
