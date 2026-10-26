# Changelog

yazcode 使用年份号段 `26.y.z`（y = 引入上游变更的批次，z = 纯内部迭代）。更早的 `1.0.x`
版本属 ZCodium 同源期（2026-10-04 ~ 10-07），历史见对应的 GitHub releases，此处不再罗列。

每个版本的完整产物与说明见 [Releases](https://github.com/yachen4ever/yazcode/releases)。

## 26.4.0 (2026-10-26)

- **IAB 用户脚本 P2：agent 工具面 + 确认流 + 设置卡**（`docs/specs/iab-userscripts.md` P2 节）：
  agent 经 `browser.userscripts` 工具面获得 `list/reload/set_enabled` 三命令（shared strict
  schema → desktop handler → core facade → manifest → 插件 api.json v12 五层接线）；确认流
  方案 (a)——命令面 set_enabled 只落 `{enabled:false, pendingApproval:true}`，`enabled:true`
  在命令面物理不可构造（BrowserCommand 唯一入口为 host 运行时，构造性来源识别，经 y430p
  复核三路攻击验证）；用户批准经浏览器设置区新设置卡（approve-once-per-content，批准钉住
  用户所见 sha256——P2 复核 M1 修复，关闭「批准→首扫」窗口）；GM 存储健康徽标与
  hash_mismatch/pendingApproval 状态呈现；manifest schema 强制 `pendingApproval ⇒
  enabled=false`（M4）。手机 Web 远控降级可用（远端 SettingService 信任路径）。
- **多目录项目 P3：UI 期**（`docs/specs/multi-root-projects.md` P3a-P3d）：项目状态底座
  （workspace→project 纯函数派生 + 读模型缓存，唯一持久所有者仍为 ProjectRepository）；
  项目编辑器对话框（新建/编辑/删除、epoch/alive 迟到防护，参考 ZCodium ProjectEditor 模式
  按本仓重建）；侧栏项目化（项目名标注 + roots 徽标 + 行菜单，分组口径保持
  workspaceKey=primary root 不另起炉灶）；文件提及跨 roots（@-mention 并发扇出附加目录）；
  草稿按 projectId 隔离。已知边界：桌面 v4 草稿首发的项目归属固化（G1）待协议通道补齐，
  已登记 spec；远端项目编辑入口待 P4。
- **构建入口 ZCODE_* 前缀级环境洗涤**：三个构建入口（buildCli/build-metadata/build-zcode）
  对宿主注入的全部 `ZCODE_*` 变量按前缀洗涤（CI 豁免保发布注入），构建输入确定性化——
  终结宿主运行时环境与仓库构建的三类冲突（staged 配置 schema 拒绝、版本烤入宿主版本号、
  构建环境翻转）。
- **IAB P2 复核 minor 修复**（y430p 复核：无 blocker/major，5 minor 中 3 项随批处置，
  M2/M3 informational 记录）。

## 26.3.0 (2026-10-25)

新批次（y 位）：内嵌浏览器用户脚本 + 多目录项目 P2。

- **IAB 内置用户脚本（monkey 类）P1**（`docs/specs/iab-userscripts.md`）：分区级
  session preload（Electron 41 `registerPreloadScript`，单一 runtime、内容全走 IPC），
  `~/.yazcode/userscripts/*.user.js` 按 `==UserScript==` 元数据与 @match 注入；
  GM_* 最小集（GM_info/addStyle/getValue/setValue/deleteValue/listValues，同步语义）；
  信任门：发现≠启用、首扫 sha256 锚定、内容变更即失活、grant fail-closed、存储仅主
  frame 可用（对齐 Tampermonkey 的全 frame 注入语义，存储面收紧）。实测：真实侧栏
  全链路 PASS，快照 8160→4944 字节（-39.4%）、动作元素 16→8（-50%），硬刷新免疫
  （立项原始痛点：临时 CSS 补丁不再随刷新失效）。
- **多目录项目 P2**（`docs/specs/multi-root-projects.md`）：协议三通道
  `additionalDirectories`（session create / resume / V4 冷恢复，strict zod max 256）；
  CLI 白名单接线——只进 skills/commands/subagents 发现（namespace=basename）与
  env-info 展示，配置装配零流动（审计测试含流动级断言与 18 引用点集合相等）；
  L1 收敛：executionDirectories 空数组=固化显式空，与「无固化值」区分，冷恢复不回落。
- **services 根 barrel browser-safe 修复**：三个带 node:* 顶层依赖的值导出移出根
  barrel（dev renderer 黑屏回归，其中 openvikingService 自 26.0.0 起即带伤）；新增
  browser-safe 静态守卫（services+shared 双 barrel，覆盖动态 import() 与单双引号）。
- **CLI 构建对宿主运行时环境免疫**：buildCli 剔除宿主注入的 builtin 配置路径变量，
  `build:cli` 不再被宿主 staged 旧 schema 配置打红。
- **批次一复核处置**（y430p 复核：BLOCKER 0 / MAJOR 3 / MINOR 15）：3 MAJOR 全部
  落地（守卫动态 import 口径、spec 因果重写、审计流动级升级），可直修 MINOR 随批
  处置（@match 通配上限、存储损坏显式失败、scriptId 路径段判定、V4 错版措辞）。

### 验收结论（2026-10-26，workwin 实机，通过）

实机验收于 workwin（Windows x64）完成，安装源为本次发布产物。三端安装包 SHA256：
win-x64 `73429f62…fffb`（实测安装源）、mac-arm64 `2f57f21a…326c`、
linux-x86_64 `b45feccd…5283`、linux-arm64 `5a52923e…95fc`。A/B/C 三项全部通过，发布放行。

- **A 安装与集成 PASS**：计划任务方式启动，UA `yazcode/26.3.0 Electron/41.0.3`；
  OpenViking 集成 0.5.23 实机握手 `tools/list` 24 工具、hooks 四事件注入；桌面会话
  技能清单 60 项含 visualize，CLI 直跑 60 项无 visualize（门禁双向验证）；gen-ui
  五类安全边界全过（合法 200 + 测高桥 postMessage、路径穿越/根外绝对路径/非 html/
  非法 host 全拒且无内容泄漏）。
- **B IAB 用户脚本实战 PASS**：目标为真实工作门户（安徽电信 EDA，
  `https://nlkf-eda.anhuitelecom.com:11050`，自签证书经「设置 → 浏览器 → 安全」放行）。
  发现≠启用（fail-closed）、首扫 sha256 锚定由 app 写回、真实页 document-start 注入
  （落盘 readyState=loading）、主世界 GM_* 六函数全隔离、GM 存储往返落盘、硬刷新免疫
  （Page.reload 后 preload 自动重跑，bootCount 递增为证）、快照瘦身 -19.1% 字节 /
  -43% 动作元素；隐藏选择器 `.assistant-iframe, iframe[src*="ai-copilot"]` 取自门户
  真实 bundle 渲染函数。注记：门户票据过期，登录态面板本体未活体验证，隐藏有效性以
  真实页注入 + 合成面板节点 + 快照差分证实（详见验收记录）。
- **C 多目录白名单 PASS**：手驱 app-server `session/create` 携 `additionalDirectories`
  后，session 级技能目录 61 项含附加目录 marker 技能（id 路径可证）；无附加目录的
  对照 session 60 项、零泄漏。commands/subagents/env-info 消费面与配置装配零流动由
  仓库审计测试覆盖（未逐一实机外测）。

## 26.2.3 (2026-10-25)

- **修复 OpenViking MCP 代理拉不起的安装器缺陷**（2026-10-25 workwin 事故根因）：安装器
  把 MCP stdio command 写成 `process.execPath`（Electron 应用本体），子进程启动的是
  yazcode GUI 而非 mcp-proxy.mjs——stdout 混入应用日志、无 JSON-RPC 响应、单实例合入后
  退出，表现为会话内 `openviking` 服务器 `Connection closed`、OV 工具全断（hooks 不受
  影响，形成「hooks 装载但工具缺失」半开态）。修复：command 附带
  `ELECTRON_RUN_AS_NODE=1` 以 node 模式执行（workwin 实测打包 exe 支持，node 24.14）。
- **安装期 MCP 握手自检**：install 写盘后用最终落盘的 command+args+env 真跑一次
  `initialize → tools/list` 握手，失败即回滚本次 CLI 配置写入并显式报错——半开态在
  安装当场暴露，不再存活数天。事故记录与复现：workwin 侧任务书
  `http://192.168.5.7:6157/workwin/ov-mcp-yazcode-fix-1025`。
- **sqlite schema 只增契约门禁**（T2，`docs/specs/sqlite-schema-contract.md`）：app
  tasks-index 与 CLI session-store 两个用户数据库纳入只增契约——删列/改约束/无默认值
  NOT NULL 新列/索引删除在 `db:schema:check` 当场变红；基线由迁移产物生成、git base
  防篡改、破坏性变更必须 `db:schema:update` 显式刷新进 review。接入 `verify:pre-push`
  与 CI 同口径。

## 26.2.2 (2026-10-25)

- **内置 OpenViking 客户端集成同步到上游 v0.5.2（integration 0.5.21 → 0.5.23）**：hook 锁
  状态文件路径改经 `withAgentHookLock` 回调传给 host；共享库四件增强——`config-schema`
  新增 `recallEventsDecayProtection` 旋钮（默认空＝关）、`pending-queue` pending 写入回放、
  `recall-core` 跨分支捕获与 recall 上下文归属、`agent-hook-runtime` 配套一行；vendored
  README 与测试文件跟随上游。
- `lib/ov-http.mjs` 保留 yazcode 本地版（v26.0.7 错误处理加固）；上游 v0.5.2 未改此文件，
  台账 provenance 已显式登记该例外。服务端 0.5.2 已于 2026-10-24 部署，本版本为可选增强
  对齐，回滚双向兼容。
- 修复 vendor 漂移检测两个缺陷：深层文件被按父目录错映射成上游扁平路径，产生大量幻影
  A/D（现按映射根截取，附回归测试并接入根测试门禁）；此前同步验证依赖「基线＝latest
  短路」，完整比对从未真正执行。`vendor-openviking-check` CI 自 10-23 起的红灯恢复可信。
- oxfmt 忽略清单补 26.1.0 改名后的 ops 技能目录与 `vendor/**`——vendored 代码不参与本仓
  格式化，防止重排破坏与上游的 blob 一致性。

## 26.2.1 (2026-10-21)

- **内置 OpenViking 客户端集成同步到上游 v0.5.1.1**：上游修的是「后续 session commit
  生成的记忆无法被 find/search 检索」，正命中记忆召回路径。同步内容为增强而非破坏性
  变更——脱敏规则扩展到工具输入与输出、`OPENVIKING_EXTRA_HEADERS` 支持、2xx 非 JSON
  响应防御、召回排除 URI 链路打通、CRLF 兼容、召回压缩 prompt 优化。
- 集成版本标记 0.5.14 → 0.5.21，与上游模板保持一致。
- 裁剪范围不变：非 zcode host 与上游测试辅助目录仍不随包分发。

## 26.2.0 (2026-10-18)

- **会话内联可视化（gen-ui P1，只读渲染链）**：agent 产出的可视化 HTML 可直接在会话内
  渲染为内联卡片，高度随内容自适应。引用格式为助手最终回复独占一行的
  `::visualize{"path":"<绝对路径>.html"}`；输出根由桌面主进程计算（数据目录下
  `visualizations/`）并经环境变量下发给 CLI 进程，模型不能自行选择路径。
- **安全边界**：主进程是唯一授权点——校验输出根、拒绝符号链接、仅普通文件、≤5MB，
  越界时渲染错误态卡片而非暴露文件；渲染 iframe 只开 `allow-scripts`（无同源、弹窗、
  顶层导航）；片段可从 CDN 白名单加载脚本，本地资源域留待后续版本。
- 桌面会话无条件携带 Interactive views 上下文；CLI 直跑不注入输出目录，引用按普通文本
  渲染；visualize 技能只在桌面会话可见。
- 契约先行：新增 `docs/specs/gen-ui-inline-visualization.md` 记录引用格式、输出目录
  约定、安全边界与验收场景。

## 26.1.4 (2026-10-16)

- **模型速度展示修复**：此前「速度」标签从未生效（缺渲染出口与轮询启动参数），现已补齐；
  速度标签同时补上整轮处理时长（如 45s / 1m30s）。
- 整轮时长的动作行渲染已回退——该信息统一由「已工作」标签承载，避免重复展示。
- 供应商归一化条件放宽为「非 anthropic 全归一」，诊断信息带 providerKind，便于定位
  中段 system 未被归一时的分层问题。

## 26.1.3 (2026-10-15)

- **openai-compat 中段 system 前移归一**：严格模板后端返回 400 的修复。归一化诊断标记
  透传到 runner 层，定位被绕过的具体分层。
- 桌面端补记主窗口 renderer 死亡事件日志——此前关闭内嵌浏览器标签会导致整应用退出
  且无法取证。

## 26.1.2 (2026-10-13)

> 本版本**未公开发布**：构建时 linux-arm64 产物缺失，release 按「任一平台产物缺失则
> 保持 draft」的设计未发布。下方内容随 26.1.3 一并交付。

- **browser-use cookies 读写工具**（get/set，跨后端 session 注入）。
- 新增 vendor/openviking 上游漂移检测（定时比对上游 latest release 的 examples 目录）。
- README 按「底座 / 从其他仓库引入 / yazcode 自研」重新梳理，并新增 CHANGELOG。

## 26.1.1 (2026-10-12)

- **视觉桥接（Vision Fallback）原生化**：主模型不支持图片输入时（not multimodal 类错误），
  自动把消息中的图片交给用户配置的 fallback 视觉模型转成文字描述并重试一次；无视觉事实
  缓存（进程 + 落盘）免后续试错；未配置时错误增强指引、桥接失败占位降级不挂死 turn。
- 模型设置：视觉桥接独立设置区（与接入端点模块平级）；fallback 选择器只列勾选了图片
  输入的模型。
- 模型设置：「自定义供应商」更名「接入端点」。

## 26.1.0 (2026-10-11)

- **引入上游 3.15.1 的官方办公插件**（Z.ai 重新以 Apache-2.0 发布）：pdf / documents /
  spreadsheets 三插件随包分发、默认启用，提供排版工作流（报告 / 创意海报 / LaTeX 简历）、
  docx-js 创建与设计系统、图表与 VBA 模板，配套 `visual-judge` 渲染质检子代理。
- MiniMax 衍生办公技能改名退居（`pdf-ops` / `docx-redline` / `xlsx-ops`），与官方插件按
  意图互补路由（造新的走插件、改旧的走 ops）；`pptx` 保留 MiniMax 版。

## 26.0.7 (2026-10-11)

- 内置 OpenViking 客户端运行时同步上游 v0.5.0（hooks 超时修复、Windows 斜杠路径匹配等）。

## 26.0.6 (2026-10-11)

- 吸收 axiom-desu 的两项修复：http.request 回调构造越界 Response 导致 agent 进程被带走；
  上游 3.15.1 白拿修复（事件驻留内存泄漏、Claude 子代理识别）。CUA 技能文本与
  @trycua/cua-driver 0.28.2 对齐。

## 26.0.5 (2026-10-10)

- 服务商级 **TLS 证书钉扎**（`tlsCaPath`）：导入自签证书（DER 自动转 PEM），按 origin
  缓存 undici Agent 并做指纹比对回退（IP 直连 + 无 IP SAN 场景）；与「跳过校验」三层互斥。
- 模型设置：SSL 高级设置折叠区（默认收起、启用带徽标）。

## 26.0.4 (2026-10-10)

- 修复 `ProviderApiConfig` 值类剥落 TLS 字段导致钉扎/跳过配置不生效的问题。

## 26.0.3 (2026-10-10)

- 服务商级「跳过 TLS 证书校验」（`allowInsecureTls`）：Node fetch 不读 Windows 证书库，
  自签内网网关按端点显式放行，无全局开关。

## 26.0.2 (2026-10-09)

- 内嵌浏览器（IAB）下载静默落盘：不再弹「另存为」，自动保存 `Downloads/yazcode/`
  （重名加序号，fail-open 回退对话框）。

## 26.0.1 (2026-10-09)

- 修复 26.0.0 桌面启动卡死：renderer 打包图引入 Node `os` 顶层调用导致 React 不挂载
  （CDP 实锤定位）；`paths.ts` 改惰性求值，并新增「公共入口不得在初始化期触碰 node:os」约束。

## 26.0.0 (2026-10-08)

- **年份号段版本线起航**（`26.y.z`）。
- **记忆提供方三选一**：内置文件记忆 / OpenViking（语义召回 + 自动沉淀）/ 不启用，
  三态互斥、无静默回落；内置 Apache-2.0 的 OpenViking 客户端集成运行时
  （`vendor/openviking/`）与安装服务（连接校验含数据面验证）。
- `typecheck:cli` 扩展到全部 13 个 CLI 子包（此前 bootstrap 三处类型错误骗过本地门禁）。
