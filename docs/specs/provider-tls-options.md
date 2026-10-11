# Spec：服务商级 TLS 选项（证书钉扎 / 跳过校验，互斥）

## 背景

内网自签 HTTPS 服务商（如 26.0.3 引入的 ahdxit_6272）在 Node 下无法直接连通：
Node fetch 用内置 Mozilla CA 包校验，**不读 Windows 证书库**，机器级装信任无效。
26.0.3 加入 per-provider「跳过校验」（`allowInsecureTls`），26.0.5 加入更安全的
「证书钉扎」（`tlsCaPath`），两者互斥。

## 行为规则

1. **两个字段挂在 `provider.config.api` 上**：
   - `api.tlsCaPath: string`——导入的自签证书文件路径（PEM；导入 DER 自动转 PEM）。
   - `api.allowInsecureTls: boolean`——跳过 TLS 证书校验（风险兜底）。
2. **互斥，三层强制**：
   - UI 交互互清：钉扎有值清「跳过」，勾「跳过」清钉扎；
   - 组件初始化：历史并存数据钉扎优先（`tlsCaPath` 非空则 `allowInsecureTls` 视为 false）；
   - 保存层：序列化前强制归一，落盘数据不允许并存。
3. **执行链**（`packages/provider/src/insecure-tls-fetch.ts`）：
   - `allowInsecureTls` → `createInsecureTlsFetch`：undici Agent `rejectUnauthorized:false`；
   - `tlsCaPath` → `createPinnedCertFetch`：Agent `connect.ca` 指向导入证书，**且校验
     对端证书指纹与导入证书 `fingerprint256` 一致**。指纹回退的原因：网关地址常为 IP
     且自签证书无 IP SAN，标准主机名校验会拒绝——此时仅信任「与导入证书完全一致」的
     对端，等价于钉扎。
   - 两种 Agent 均按 **baseUrl origin 缓存**，同 origin 复用连接池。
4. **schema 兼容**：`provider-data-schema.ts` 容忍已废弃的 `tlsCaPem`（PEM 内联旧键）
   ——strict 拒收会让携带它的整份 Provider 配置校验失败（26.0.5 实测：workwin 模型
   全消失）。读到旧键按迁移处理，不拒绝。
5. **模型检测同语义**：检测请求（`remoteModelCatalog.ts`）与正式执行链使用同一份
   TLS 字段与 fetch 构造，检测连通即代表执行链连通。

## 状态所有者

- 字段定义与校验：`packages/provider/src/config/provider-data-schema.ts`（complete 显式 + sparse 继承）。
- 值类保留：`packages/provider/src/config/provider-config.ts` 的 `ProviderApiConfig`
  （构造器 / overlay / toJSON 三处必须对称保留 TLS 字段——26.0.4 修过「flag 进值类即被剥」）。
- fetch 构造：`packages/provider/src/insecure-tls-fetch.ts`。
- UI：`packages/ui/src/settings/model-provider-section/`（SSL 高级设置折叠区，仅 https
  baseUrl 时显示，启用带徽标）。

## 不变量

1. 保存后的持久化数据中 `tlsCaPath` 与 `allowInsecureTls=true` 永不同时出现。
2. 钉扎失败必须是**可辨识错误**（指纹不匹配带期望/实际指纹前缀），不静默降级为跳过校验。
3. 检测链与执行链的 TLS 语义不分叉；分叉视为 bug。

## 验收场景

1. https baseUrl 显示 SSL 高级设置折叠区；http 不显示。
2. 导入证书保存后，执行链对自签网关连通；换发不同证书的网关报指纹不匹配。
3. 勾选跳过校验后自签网关连通；导入证书时跳过勾选被自动清除（互斥）。
4. 携带 `tlsCaPem` 旧键的存量配置加载不报错，模型列表正常。
5. 检测可用模型与实际对话使用同一 TLS 配置。
