# Spec：视觉桥接（Vision Fallback）

## 背景

用户把截图贴进会话时，客户端把图片作为 image content block 放进消息发给主模型。
公司 openai 兼容网关（newapi 分发）上的纯文本模型会直接拒绝该请求并返回 HTTP 400：

```text
dsv4 is not a multimodal model
glm-5 is not a multimodal model
```

turn 因此直接失败，agent 没有任何自救机会。关键约束：该网关的 `/models` 只返回
`id/created/object/owned_by/supported_endpoint_types`，**没有模态元数据**——无法在
请求前判断哪个模型接受图片，只能靠实测失败驱动（网关上仅部分模型接受图片）。

本能力在 runtime 层原生化「图片转文字」桥接：主模型拒绝多模态请求时，自动把消息中的
图片交给用户配置的 fallback 视觉模型转成文字描述，再重试一次请求。

## 行为规则

### 设置（appSettings 顶层字段）

`appSettings` 新增顶层字段 `visionFallback`（与 `memoryProvider` 同级）：

```ts
visionFallback?: {
  enabled: boolean       // 缺省按 false 处理，不默认开启
  providerId?: string    // fallback 视觉模型所在 provider
  modelId?: string       // fallback 视觉模型 id
}
```

- 设置页模型设置区新增「视觉桥接」卡片：启用开关 + fallback provider/model 选择。
  模型选择复用「检测可用模型」链路（`IProviderSettingsService.listRemoteModels`），
  从所选 provider 的真实模型清单里点选，不允许手填不存在的 id。
- schema 向后兼容：旧配置无此字段 = 未启用。
- 设置保存后对**之后创建**的 session runtime 生效；已活跃 runtime 不热更新
  （runtime 配置在 App 创建时冻结，与 `modelSelection` 等字段同一语义）。

### 触发与桥接（核心行为）

1. **失败驱动，不预判**：不做「模型是否有视觉」的元数据探测。图片随消息原样发出。
2. **错误识别**：模型请求失败且错误文本（大小写不敏感）命中多模态拒绝特征集合时触发。
   特征至少覆盖：`not a multimodal model`、`does not support image`、
   `image.*not support`、`unsupported.*image`、`multimodal`。
   HTTP 400/422/503 均可携带。特征集合集中定义为可测试的纯函数（core 新模块），
   匹配范围包括错误的 `message`、`responseBody` 等 string 字段与 `cause` 链。
3. **无视觉缓存**：识别命中后，把主模型的 `providerId+modelId` 记入「无视觉」缓存。
   缓存 = 进程级 Map + 数据目录（`<cliStorageRoot>/vision-fallback/no-vision-models.json`）
   的小 json，容错读取（文件损坏/不可读时回退进程内，不抛错）。后续该模型的请求
   **直接桥接**，不再试错。主模型「无视觉」是模型自身事实，不随 fallback 设置变化；
   文件损坏时进程内缓存继续生效，无需主动失效逻辑。
4. **桥接执行**：对消息中每个 image block（base64/data URL 已在手），用 fallback 模型
   发一次 openai 兼容 `chat/completions`（图片以 data URL 进 `image_url`），取回文字描述。
   - 请求 URL：base 以 `/v1` 结尾则原样拼 `/chat/completions`，否则补 `/v1` 再拼。
   - 多图逐张桥接（串行，单张失败不影响后续）。
   - 请求带 `max_tokens` 上限与超时（AbortSignal），常量集中在桥接模块。
   - 描述 prompt 为固定常量（英文指令，含"描述图中文字"），不读取会话语言。
5. **TLS**：桥接请求复用 fallback provider 配置的 `tlsCaPath`（钉扎优先）/
   `allowInsecureTls`（跳过）语义，经 `packages/provider/src/insecure-tls-fetch.ts`
   现成机制包装；桥接模块不另写 TLS 逻辑。出口代理与模型请求同源
   （proxy-aware fetch），HTTP 状态非 2xx 视为桥接失败并携带原因。
6. **消息变换**：重试时把 messages 中**所有** image block 替换为文字块：
   `[图片描述（由 {modelId} 桥接）] {描述文本}`。桥接失败的单图替换为占位
   `[图片无法描述: {原因}]`。文本块、工具消息结构保持不变，变换后消息必须仍是
   合法的 `ModelInputMessage[]`。
7. **降级**：
   - fallback 未配置（未启用/缺 providerId/modelId）→ 不重试，把错误增强为可操作指引
     （保留原文 + 「可在 设置→模型设置→视觉桥接 配置 fallback 模型，或改用支持视觉的模型」）。
   - 桥接请求失败（网络/非 200）→ 该图替换为占位，turn 继续；**桥接失败不允许把 turn 挂死**。
   - 单张图片桥接失败不阻断其余图片与重试。
8. **日志**：桥接成功/失败/回落用 `createServiceLogger` 风格的结构化日志（core 侧经
   runtime logger，info 级一次性事件）；不打印 API key 与完整 base64。
9. **重试边界**：每个 turn 的模型请求最多因视觉桥接重试一次；重试请求再次失败时
   按普通模型错误处理，不再循环。重试复用同一 assistantMessageId；adapter runner 的
   retry-safe prelude 保证被拒请求不会向 core 泄漏 start 等流事件，重试事件序列与
   正常请求一致。

## 状态所有者

```text
设置事实：setting.json（~/.yazcode/v2/setting.json），唯一写入方 = Host SettingService
  → bootstrap 在 createZCodeApp 时容错读取，冻结进 AgentRuntimeConfig.visionFallback
桥接执行：adapters/model 纯函数 + 可注入 fetch；bootstrap 组装 VisionBridgePort
  （经 Provider Registry 解析 fallback provider 的 baseUrl/apiKey/TLS）注入 runtime deps
无视觉缓存：core runtime helper 拥有（进程 Map + 落盘文件），bootstrap 只提供路径
消息变换：core runtime helper 纯函数，编排点 = runModelTextRequest 包装层
```

- 依赖方向：core 只消费注入的 `VisionBridgePort` 接口（定义在 contracts），不依赖
  adapters；bootstrap → adapters/provider 公开入口；禁止反向与深层导入。
- UI 只经既有 `updateSharedSettings`（appSettingsPatchSchema）写入设置，不直连 runtime。

## 明确不做

- 不做「模型视觉能力」的元数据探测（网关不支持，失败驱动已够）。
- 不改 `packages/shared/src/zcode-protocol`——本能力全在 runtime 侧，设置读取走
  本地 setting.json 容错读取（协议下发留待后续需要时另立 spec）。
- 不动用户级 `vision-bridge` 技能（workwin 本地资产，由用户侧退役）。
- 不覆盖远端 workspace（agent 进程在远端机器上，读不到本机 setting.json）；
  远端会话按未配置处理，属已知边界。

## 验收场景

1. 未配置 fallback + 无视觉模型 + 贴图 → 请求失败，错误含原文与配置指引。
2. 配置 fallback + 无视觉模型 + 首次贴图 → 试错一次 → 自动桥接 → 重试成功，
   回复基于图片描述。
3. 同模型第二次贴图 → 不再试错，直接桥接（缓存命中，原始请求不发出）。
4. 视觉模型为主模型 → 不触发桥接，图片原样。
5. fallback 模型不可达 → 图片替换占位，turn 继续。
6. 多图 → 逐张桥接，全部替换。
7. 设置页 → 开关 + provider/model 选择器可用，模型选择走真实检测链。
8. 旧配置（无 visionFallback 字段）→ 加载不报错，功能关闭。

场景 2/3/5 由 mock fetch 的集成测试证明（无真实网关依赖）。
