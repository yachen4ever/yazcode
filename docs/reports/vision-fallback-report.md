# 交付报告：视觉桥接原生化（Vision Fallback）

分支 `feat/vision-fallback`（基于 main @ `fce13da`），由 m5air 侧按任务书完成，交 r9000x 侧验收。

## 一、改动清单

| Commit | 文件 | 意图 |
| --- | --- | --- |
| `32d6ff5` docs(spec) | `docs/specs/vision-fallback.md` | 契约先行：行为规则/状态所有者/验收场景（spec 第一个 commit） |
| `d7fc257` feat(shared) | `packages/shared/src/validationAppSettings.ts`<br>`packages/shared/src/protocol.ts`<br>`packages/shared/src/validation.ts`<br>`packages/shared/package.json`（+test script）<br>`packages/shared/test/visionFallbackSettings.test.ts` | appSettings 顶层新增 `visionFallback`（enabled/providerId/modelId），对象 schema + patch schema + AppSettings 类型三处登记；向后兼容（字段缺席=关闭，enabled 缺省非 true） |
| `a6c78cc` feat(adapters) | `apps/zcode-cli/packages/adapters/src/model/vision-bridge.ts`<br>`apps/zcode-cli/packages/adapters/src/model/vision-bridge.test.ts`<br>`apps/zcode-cli/packages/adapters/src/model/index.ts`<br>`apps/zcode-cli/packages/adapters/package.json`（+test script） | 桥接请求执行面：URL 规范化（`/v1` 语义）、chat/completions 请求构造、响应描述解析、出口代理 + TLS 钉扎/跳过复用（`createPinnedCertFetch`/`createInsecureTlsFetch`）、可注入 fetch、max_tokens 与超时常量 |
| `3b1e3fa` feat(core) | `apps/zcode-cli/packages/contracts/src/interfaces/vision-bridge.port.ts`（+两处 index 导出）<br>`apps/zcode-cli/packages/core/src/runtime/helpers/vision-fallback.ts`<br>`apps/zcode-cli/packages/core/src/runtime/helpers/index.ts`<br>`apps/zcode-cli/packages/core/src/runtime/deps.ts`<br>`apps/zcode-cli/packages/core/src/runtime/types.ts`<br>`apps/zcode-cli/packages/core/src/runtime/internal.ts`<br>`apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts`<br>`apps/zcode-cli/packages/core/src/runtime/methods/model.ts`<br>`apps/zcode-cli/packages/core/test/runtime/vision-fallback.test.ts`<br>`apps/zcode-cli/packages/core/package.json`（+test script） | contracts 定义 `VisionBridgePort`（可辨识联合结果，不抛错）；core 新增多模态拒绝特征纯函数、无视觉缓存（进程 Map + 落盘 json 容错读取）、image block 收集/替换纯函数、逐张桥接编排；`runModelTextRequest` 包装层实现「试错一次→桥接→重试一次」与未配置降级 |
| `4bb67ca` feat(bootstrap) | `apps/zcode-cli/packages/bootstrap/src/app/vision-fallback-config.ts`<br>`apps/zcode-cli/packages/bootstrap/src/app/vision-bridge-port.ts`<br>`apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts`<br>`apps/zcode-cli/packages/bootstrap/src/app/create-app.ts` | CLI 侧容错读取 `~/.yazcode/v2/setting.json` 的 visionFallback 子树（只校验子树，其余字段损坏不连累）冻结进 `AgentRuntimeConfig`；端口实现经 Provider Registry 活视图解析 fallback provider 连接事实（baseUrl/apiKey/TLS）；`createZCodeApp` 注入 `visionBridgePort` |
| `c28ae0c` feat(ui) | `packages/ui/src/settings/VisionBridgeSettingsCard.tsx`<br>`packages/ui/src/settings/ModelProviderSection.tsx`<br>`packages/ui/src/i18n/locales/{zh-CN,en-US,fa}.ts` | 模型设置区底部「视觉桥接」卡片：启用开关 + fallback provider/model 选择；模型选择复用 `listRemoteModels` 真实检测链（不允许手填），三语文案，复用 SettingsGroupCard/SettingsRow/Switch/Select 现有组件 |
| `54dc027` docs | `docs/README.md` | 规格索引补 vision-fallback 条目 |

## 二、关键决策与理由

1. **设置如何进 runtime（不改协议的约束下）**：`zcode-protocol` 的 runtime preferences schema 是
   `.strict()`，加字段即改协议，被任务书禁止。选择 bootstrap 在 App 创建时直接容错读取
   Host SettingService 落盘的同一份 `~/.yazcode/v2/setting.json`（home 解析优先级与
   SettingService 一致，dev 数据目录隔离同样生效），冻结进 `AgentRuntimeConfig.visionFallback`。
   代价：设置变更对**之后创建**的 session 生效（与 modelSelection 等字段的冻结语义一致），已写入 spec。
2. **依赖方向**：core 的 package.json 不依赖 adapters/provider（现状边界）。因此桥接的
   网络执行放 adapters（与 model-execution 同层），core 只消费 contracts 里定义的
   `VisionBridgePort` 接口，bootstrap 组装端口（Registry 活视图 + adapters 纯函数）注入。
   `pnpm architecture:check --changed` 通过。
3. **端口结果用可辨识联合而非抛错**：单图桥接失败必须能逐张降级（占位替换、turn 继续）；
   抛错会把「失败原因」和「失败这一事实」耦在一起。
4. **无视觉缓存的所有者**：core 拥有（进程级 Map 按缓存路径记忆 + `writeFile` 容错落盘），
   bootstrap 只提供路径。主模型「无视觉」是模型自身事实，与 fallback 配置无关，因此
   cacheFilePath 始终下发（未配置 fallback 也记录），用户日后配置后新会话直接命中免试错。
5. **重试的事件语义（免 UI 双气泡）**：adapter runner 的 retry-safe prelude 机制
   （`runner-stream.ts` 的 `pendingRetrySafeEvents`）保证请求期失败（400 拒绝）不会向 core
   泄漏 start 等流事件——AI SDK 的 start 是本地合成、被扣到首个真实 provider event 之后。
   因此 core 包装层捕获异常后重试，重试请求的事件序列与正常请求完全一致，无重复 start/error。
6. **特征匹配范围**：错误对象的 `message`/`responseBody`/`text`/`reason` string 字段 +
   `cause` 链下探（深度 6），大小写不敏感；特征集合集中在
   `helpers/vision-fallback.ts` 的 `MULTIMODAL_REJECTION_PATTERNS` 一个数组里。
7. **设置文件只校验 visionFallback 子树**：不整份 `appSettingsSchema.parse`——设置文件其他
   字段的损坏不应连累视觉桥接的可用性，反之亦然。

## 三、与任务书的偏差

1. **5.2.8 日志**：任务书写 `createServiceLogger`；core runtime 侧统一经 runtime logger
   （`this.logger`，`module: "core.runtime"`，info 一次性事件），bootstrap/services 侧的
   serviceLogger 不适用于 core。语义（info 级、不打印 key 与 base64）与任务书一致。
2. **落点微调**：任务书倾向「触发判定、缓存、消息变换编排：core runtime（model-errors.ts
   邻近新增模块）」——实际为 `helpers/vision-fallback.ts`（model-errors.ts 同目录邻近）+
   编排点在 `methods/model.ts` 的 `runModelTextRequest` 包装层，符合倾向。
3. **无其他偏差**；`vision-bridge` 用户级技能未触碰，协议未改动，版本号未动。

## 四、测试执行结果（真实输出摘要）

| 命令 | 退出码 | 输出摘要 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | `tsc -b`（rpc/provider/provider-node/shared/services/client/server/zcode-server-cli/ui/web/desktop.host）无错误 |
| `pnpm lint` | 0 | `Found 91 warnings and 0 errors`（91 条警告为 main 基线，`git stash` 对照确认本分支零新增） |
| `pnpm verify:pre-push` | 0 | lint + `architecture:check --changed`（`architecture: OK, violations: 0`）+ check:skill-residue + 13 个 CLI 子包 typecheck 全部通过 |
| `pnpm --filter @zcode/shared test` | 0 | `tests 9 / pass 9 / fail 0`（visionFallbackSettings 5 组：缺省兼容/enabled 缺省 false/合法保留/patch 写入/非法值拒绝） |
| `pnpm --filter @zcode/adapters test` | 0 | `tests 13 / pass 13 / fail 0`（vision-bridge 7 组：URL 带与不带 `/v1`/尾斜杠、请求载荷与常量、响应解析、多图逐张 mock fetch 调用序列、非 2xx 与网络错误、空描述失败） |
| `pnpm --filter @zcode/core test` | 0 | `tests 15 / pass 15 / fail 0`（特征识别 3 组 + 缓存 2 组 + 消息变换 3 组 + 编排集成 7 组，见下表） |
| `pnpm architecture:check --changed` | 0 | `violations: 0` |

## 五、验收场景自测表

| # | 场景 | 预期 | 自测 | 证据 |
| --- | --- | --- | --- | --- |
| 1 | 未配置 fallback + 无视觉模型 + 贴图 | 请求失败，错误含原文与配置指引 | ✅ | core 测试「场景 1 降级」：断言错误 message 同时匹配 `/dsv4 is not a multimodal model/` 与 `/设置→模型设置→视觉桥接/`，且 generateText 仅调用 1 次（不重试） |
| 2 | 配置 fallback + 无视觉模型 + 首次贴图 | 试错一次→自动桥接→重试成功 | ✅ | core 测试「场景 2」：mock 模型对含图请求抛多模态拒绝；断言 generateText 共 2 次、第 2 次消息无 image block 且文本为 `[图片描述（由 qwen38 桥接）] …`、端口收到原始 data URL |
| 3 | 同模型第二次贴图 | 不再试错，直接桥接（缓存命中） | ✅ | core 测试「场景 3」：同缓存文件路径的第二个 fake runtime，generateText 仅 1 次且消息无图片（原始请求未发出）；落盘断言缓存文件含 `gw\u0000dsv4` |
| 4 | 视觉模型为主模型 | 不触发桥接，图片原样 | ✅ | core 测试「场景 4」：单次请求含 image block、端口 0 调用、缓存文件无记录 |
| 5 | fallback 模型不可达 | 图片替换占位，turn 继续 | ✅ | core 测试「场景 5」：端口返回 `ok:false`（HTTP 503）；断言重试成功、占位文本为 `[图片无法描述: HTTP 503: upstream unavailable]`、turn 返回正常结果 |
| 6 | 多图 | 逐张桥接，全部替换 | ✅ | adapters 测试「多图逐张」断言每图各发一次请求；core 测试「多图与混合文本全部替换，未拿到的图替换占位」断言 3 block 全转 text 且纯文本消息原样 |
| 7 | 设置页 | 开关+模型选择器可用，选择走真实检测链 | ✅ | **dev:desktop 真机走查**（macOS dev 实例，CDP 驱动）：卡片渲染于模型设置页底部（截图核对）；开关打开后展开表单；provider 下拉列出 4 个 API Key provider；选择 MiniMax 后点「检测可用模型」→ 下拉渲染其真实在线模型清单（MiniMax-M3.1-Flash-Preview 等 9 项）；选 MiniMax-M2.7 后 `setting.json` 落盘 `{"enabled":true,"providerId":"minimax","modelId":"MiniMax-M2.7"}`。测后已恢复（开关关闭 + 字段移除） |
| 8 | 旧配置（无 visionFallback 字段） | 加载不报错，功能关闭 | ✅ | shared 测试「缺省字段向后兼容」+ core 测试「场景 8：未启用时行为与普通请求一致」 |

## 六、已知限制

1. **设置变更对新 session 生效**：runtime 配置在 App 创建时冻结（决策 1），已活跃会话不热更新。
   远程 workspace 的 agent 进程读不到本机 setting.json，按未配置处理（spec「明确不做」）。
2. **模型显式声明 `supportsImage:false` 时不触发桥接**：这类模型在既有
   `projectMessagesForInputFormat` 投影边界就把图片替换为不可用占位（客户端语义，先于网关），
   不会产生多模态 400——桥接是失败驱动的，该路径本就无需桥接。
3. **桥接描述的 prompt 为固定英文常量**（含「描述图中文字」），描述文本语言由 fallback 模型决定；
   主模型收到的是 `[图片描述（由 {modelId} 桥接）] …` 文字块。
4. **桥接请求不走官方 Coding Plan 网关改写**：fallback provider 按普通 openai 兼容端点直连
   （出口代理与 TLS 语义与执行链同源）；官方套餐 provider 未纳入 fallback 候选（UI 只列
   API Key provider）。
5. 测试环境无真实公司网关，场景 2/3/5 以 mock fetch/端口集成测试证明；端到端真网关验证
   按任务书由 r9000x 侧在 Windows 办公机执行。
