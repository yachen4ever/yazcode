# Spec：IAB 内置用户脚本（monkey 类）——P1 分区级 preload / P2 工具面 + 确认流 + 设置卡

## 背景

内嵌浏览器（IAB，`persist:zcode-embedded-browser` partition）按站点固定注入脚本/CSS 的能力缺口：
页面级优化（隐藏垃圾面板、简化门户元素）目前只能靠命令式 `executeJavaScript` 临时补丁，
硬刷新即失效。本 spec 定义 P1 最小可用能力：应用内置一个 preload runtime，扫描用户脚本目录，
按 `@match` 在 document*start 把「启用且校验通过」的脚本注入 IAB guest 的隔离上下文，
并提供 GM*\* 最小集 shim。调研结论见 m5air 调研报告（路线 1：分区级 preload）与
y430p 立项回执（三条硬性要求）。

P1 边界：无 UI、无 agent 工具面（P2）、无 GM_xmlhttpRequest、无确认流 UI、无 fixture 实机测量
（见「剩余项」）。启用的运维路径是手工编辑 `setting.json` 的 manifest 子树。

## 行为规则

1. **脚本发现与格式**：扫描 `~/.yazcode/userscripts/*.user.js`（路径经 `getZCodeDataRootDir()`
   解析为 `{数据根}/.yazcode/userscripts`，默认即 `~/.yazcode/userscripts`，dev 数据目录隔离
   `ZCODE_DATA_BASE_DIR` 同样生效）。脚本头部为 `==UserScript==` 元数据块：
   - `@name`（缺省用文件名 stem）、`@match`（至少一条，多条任一命中即注入）、
     `@run-at`（`document-start`｜`document-end`｜`document-idle`，缺省 `document-start`）、
     `@grant`（多条；缺省等价 `none`）、`@version`/`@namespace`/`@author`/`@description`
     （仅进 GM_info，不参与门控）。
   - 无有效元数据块（缺 `==UserScript==` 起止标记或缺 `@match`）的文件：不入服务集，记录一条
     日志。目录只扫一层，不递归子目录。

2. **信任与启用（approve-once-per-content 的种子机制）**：manifest 记录在
   `AppSettings.embeddedBrowserUserscripts`：`Record<scriptId, { enabled: boolean; sha256?: string }>`，
   `scriptId` = 文件名去掉 `.user.js` 后缀。规则：
   - **发现 ≠ 启用**：新出现在目录里、manifest 无条目的脚本不注入（fail-closed）。
   - **锚定**：条目 `enabled: true` 且无 `sha256` 时，store 在下一次匹配扫描时计算当前文件
     sha256 并持久化（一次性锚定写），随后开始注入。
   - **一致性门**：只服务「`enabled === true` 且条目 `sha256` 与当前文件 hash 一致」的脚本。
     文件内容变更 → hash 不一致 → 停止注入并记录 warn（不自动重锚定——任何修改都必须
     经显式重新批准）。
   - **重新批准**：把条目改回 `{ enabled: true }`（清除 sha256）即重新锚定。P2 的确认流
     （approve-once-per-content UI）替换这一手工路径：设置卡批准改为钉住所见 sha256
     （M1 修订，见 P2 行为规则 2），手工清 sha 重锚路径保留。

3. **grant fail-closed**（回执硬性要求 ③）：仅接受
   `none / GM_addStyle / GM_getValue / GM_setValue / GM_deleteValue / GM_listValues`。
   脚本声明了白名单之外的 grant（如 `GM_xmlhttpRequest`）：整只脚本拒载（不入服务集）
   并记录一条日志，不静默降级、不裁剪 grant 后继续加载。`GM_info` 不需要声明，恒可用。

4. **@match 匹配**：Chrome match pattern 语义的 http(s) 子集——
   `scheme://host/path`，scheme ∈ {`http`, `https`, `*`}（`*` = http 或 https）；host 支持
   精确、`*`（任意）与 `*.example.com`（含自身与子域）；path 以 `/` 开头，`*` 匹配任意字符
   （含 `/`），单 pattern path 段的 `*` 数量超过宽松上限（8）视为非法——超限会让 main
   进程 URL 匹配产生多项式回溯放大（复核 m2-1）；`<all_urls>` 视为 `*://*/` + 任意
   path，仍限定 http(s)。非法 pattern 按解析失败处理（该脚本不入服务集并记录）。
   非 http(s) URL 永不匹配任何 pattern。

5. **注入面与单一 runtime**（回执硬性要求 ②）：
   - app 创建时对 `persist:zcode-embedded-browser` 分区执行一次
     `session.registerPreloadScript({ filePath: <内置 runtime>, type: "frame" })`
     （Electron 41 API；`setPreloads` 已废弃）。runtime 路径由 main 以
     `join(import.meta.dirname, "../preload/userscriptRuntime.cjs")` 解析，dev 与打包态同构
     （与 `embeddedBrowserJavaScriptDialog.cjs` 同一模式）。
   - **分区级 session preload 只注册这一个**；脚本内容一律经 IPC 分发，preload 本体不含
     任何用户脚本；未来官方「固定 preload」需求并入同一 runtime，禁止再注册第二个
     session 级 preload（guest 的 per-webview preload——对话框桥、录像器——是既有 app 功能
     挂点，不属于用户脚本分发面，与 session preload 叠加生效，互不竞争）。
   - runtime 按 frame 自身 URL 匹配 `@match`，对所有命中 frame 各注入一次，按 frame
     幂等（重复执行守卫）——与 Tampermonkey 的 per-frame 语义对齐（产品裁决 a，
     2026-10-25 复核 M2 纠正因果后重定）。
     **注入面因果（纠正本 spec 此前的错误陈述）**：guest 的 `will-attach-webview`
     强制项（`desktopWindowChrome.ts`）与 IAB `<webview>` tag（`BrowserViewportSurface.tsx`）
     **都显式开启** `nodeIntegrationInSubFrames`（「仅主 frame」的前提不成立），
     且 session preload 注册为 `type: "frame"`（帧上下文 vs service-worker 上下文，
     不区分主/子 frame）。因此：无 src 的**继承型空 frame 不触发 preload**；发生
     真实导航的**同源/同进程子 frame 会触发 preload**，按该 frame 自身 URL 参与匹配
     并注入。**跨域 OOPIF（站点隔离子 frame）是否传播该 flag 未实测**，列为 fixture
     补测项（见验收场景 9 残余）。
   - **GM 存储仅主 frame 可用**：子 frame 的存储函数位为 `undefined`（runtime 只注入
     `GM_info`/`GM_addStyle`），脚本调用即抛 TypeError 且被 `executeScript` 的
     try/catch 吞掉——存储请求根本不会发出。main 侧 `sub_frame_denied` 守卫由此确认
     为**不可达的纵深防御**，不是可达分支（复核实测结论）。能力边界相应修正：
     **同源/同进程 iframe 内部元素**的脚本清理在 P1 能力内（脚本会注入并命中）；
     跨域 iframe 待 OOPIF 补测后定界。外层 CSS 隐藏整个 iframe 的常见场景（AI
     Copilot 面板）不受影响。GM 存储面若要放开到子 frame 需过安全评审（当前仅主
     frame 是产品边界）。main 侧主 frame 判定以 `event.senderFrame` 为准，不信任
     renderer 传参。
   - **非 http(s) scheme（chrome-error、about:blank、devtools 等）上 runtime 直接 no-op**。

6. **IPC 面（恰好 3 个 channel，参数校验在 main）**：
   - `zcode:userscripts:match`（invoke）：入参 `{ url }`；main 校验 url 为合法 http(s) URL，
     扫描目录并计算当前服务集，返回
     `[{ scriptId, name, version, namespace, runAt, grants, code, info }]`——
     **回包不含任何文件路径**。
   - `zcode:userscripts:get` / `zcode:userscripts:set`（sendSync，保证 GM_getValue 的
     Tampermonkey 同步语义与 set→get 顺序）：get 入参 `{ scriptId, key }`，set 入参
     `{ scriptId, key, value }`；main 校验 scriptId 在当前服务集内、key 为非空字符串
     （≤512 字符）、value JSON 可序列化；拒绝时返回明确失败结果（不抛裸异常给隔离世界）。
   - GM 存储所有者在 main：每脚本一个 JSON 文件（`{数据根}/.yazcode/userscript-storage/<scriptId>.json`），
     main 内按 scriptId 串行化读改写（并发 frame 不丢更新），单脚本存储上限 2 MB，超限拒绝。
     存储文件损坏（JSON 解析失败 / 顶层形状非法）显式回 `storage_corrupt`，损坏文件
     原样保留、不自动清数据（复核 m2-5：静默当空等于丢数据）；用户修复或删除文件后
     存储恢复可用。

7. **GM\_\* 语义**：`GM_info`（脚本元数据对象）、`GM_addStyle(css)`（向当前文档插入 `<style>`，
   document*start 时 head 未就绪则挂到 documentElement 或延迟到 DOMContentLoaded）、
   `GM_getValue(key, defaultValue?)`、`GM_setValue(key, value)`、`GM_deleteValue(key)`、
   `GM_listValues()`。GM*\* 以脚本函数参数注入（不是 window 全局），页面世界物理不可见。
   `@run-at` 等待策略由 runtime 内部实现：start = 立即；end = DOMContentLoaded；
   idle = load 事件（已过则立即）。

8. **sandbox / contextIsolation 以实测为准**（回执硬性要求 ①）：main 侧
   `will-attach-webview` 已对 guest 强制 `sandbox: true` / `contextIsolation: true` /
   `nodeIntegration: false`（`desktopWindowChrome.ts`），代码层面成立；但 spec 不以此替代
   实测。fixture 实测断言（标注为 **fixture 实测项**，步骤见文末）：
   - 断言 A：页面主世界摸不到 `GM_*`（`window.GM_info === undefined` 等六个全查）。
   - 断言 B：隔离上下文拿不到页面 JS 变量（runtime 侧探测 `window.__pageProbe === undefined`，
     页面先行设置探针）。
   - 实测同时覆盖：挂起/恢复（销毁/重建 guest）后 preload 仍自动生效；`new Function`
     执行脚本不受页面 CSP 影响（内网门户场景验证一次）。

## 状态所有者

| 状态                       | 所有者                                                                 | 说明                                                                                                                                                                                                                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| manifest（enabled/sha256） | `AppSettings.embeddedBrowserUserscripts`（SettingService 唯一写路径）  | **论证**：回执要求复用现有设置存储、避免自建第二份状态文件（两套状态所有者）。AppSettings 是桌面端应用级持久状态的唯一所有者，`visionFallback` 字段已有同模式先例（storage schema + patch schema + 类型三处登记）。store 不直接落盘，经注入的 manifest 端口（生产实现包 SettingService）读写，测试可替换。 |
| 脚本文件                   | 用户（`~/.yazcode/userscripts/`）                                      | store 只读扫描，永不写脚本文件；用户级资产，跨 workspace 同源，站内作用域用 `@match` 表达。                                                                                                                                                                                                                |
| GM 运行时数据              | main 侧 userscriptStorage（per-scriptId JSON 文件）                    | 唯一写者是 main 的 IPC handler；preload 只经 IPC 读写。与 manifest 分离：前者是脚本运行时数据（跟随数据根），后者是用户决策（跟随设置）。                                                                                                                                                                  |
| runtime 本体               | app bundle（tsup preload entry → `out/preload/userscriptRuntime.cjs`） | 可信应用代码；路径解析与既有 preload 一致（dev/打包同构），不做数据目录写入。                                                                                                                                                                                                                              |
| 扫描缓存                   | 无                                                                     | store 每次匹配请求全量重扫（目录规模为个位数文件、KB 级，重扫同时天然完成 hash 一致性复核）；不做 TTL/事件订阅缓存，避免第二个状态所有者。                                                                                                                                                                 |

事件顺序（注入时序）：

```
app ready（main）
  1. installIabUserscripts()：session.fromPartition("persist:zcode-embedded-browser")
     .registerPreloadScript({ filePath: <out/preload/userscriptRuntime.cjs>, type: "frame" })
     + 注册 3 个 IPC channel（一次；幂等守卫防重复注册）

每次导航（Electron 自动，含挂起恢复后重建的 guest；主/子 frame 各一次）
  2. runtime 在隔离世界 document_start 运行；非 http(s) scheme no-op
  3. runtime → invoke("zcode:userscripts:match", { url })
  4. main 重扫目录 → 计算服务集（enabled ∧ sha 一致 ∧ grant 合法 ∧ @match 命中）
     →（首个 enabled 无 sha 的条目在此锚定并持久化）→ 返回脚本列表（无文件路径）
  5. runtime 按 runAt 等待，逐脚本 new Function 注入 GM_* 参数后执行；
     脚本内 GM 存储读写经 sendSync 落 main（main 按 scriptId 串行化）
```

已知代价：document_start 与 match 返回之间一跳 IPC 延迟（内网门户毫秒级，表现为样式应用
略晚于首帧）。若实测闪烁明显，P2 增加「main 在 did-navigate 主动推送」优化，不改架构。

## 接口

- **装配**：`packages/desktop/src/main/userscripts/userscriptBootstrap.ts` 导出
  `installIabUserscripts({ logger, settingService })`（注册 session preload 与 IPC
  channels），由 `main/index.ts` 的 `app.whenReady()` 调用（`registerIabDownloadAutoSave`
  邻近）。
- **IPC**（channel 名与 wire 类型定义在 `userscriptIpcContract.ts`，main 与 preload 共用）：
  - `zcode:userscripts:match`（invoke）→ `UserScriptMatchResponse`
  - `zcode:userscripts:get` / `zcode:userscripts:set`（sendSync）→ `UserScriptStorageResult`
- **store**：`userscriptStore.ts` 的 `createUserscriptStore({ scriptsDir, manifestPort })`，
  `scanServeableScripts()` 返回服务集（含解析失败/拒载原因的日志记录）。
- **storage**：`userscriptStorage.ts` 的 `createUserscriptStorage({ rootDir })`。
- **tsup**：`packages/desktop/tsup.config.ts` preload 配置新增
  `"preload/userscriptRuntime": "src/preload/userscriptRuntime.ts"`。
- **shared**：`packages/shared/src/validationAppSettings.ts` 新增
  `embeddedBrowserUserscriptsSettingsSchema`（storage + patch schema 两处登记），
  `packages/shared/src/protocol.ts` 的 `AppSettings` 增加可选字段（与 `visionFallback` 同模式）。

## 明确不做（P1 边界外）

- 不做 UI（设置卡片）、agent 工具面（`userscript_list/set_enabled/reload` 命令）、确认流
  （approve-once-per-content UI）——P2。
- 不做 `GM_xmlhttpRequest`、`GM_registerMenuCommand`、`GM_setClipboard`、`GM_download`
  （跨域/剪贴板/下载面不进 P1）。
- 不做 SPA 软导航（pushState/replaceState）后的重新匹配——脚本按文档 URL 在加载时匹配一次，
  与 Tampermonkey 缺省行为一致。
- 不 vendor Violentmonkey 内核；脚本格式保持 `==UserScript==` 兼容。
- 不做脚本目录的 fs.watch 事件订阅、TTL 缓存。
- `unsafeWindow` 不提供（隔离世界拿不到页面 JS 是特性，不是缺陷）。

## 验收场景

1. **头解析**：完整元数据块解析出 name/match/run-at/grant；缺省 run-at=document-start、
   缺省 grant=none；无元数据块或缺 @match 的文件被拒载并记录。
2. **@match 匹配**：scheme 通配（`*://`）、`*.example.com` 命中自身与子域、精确 host 不命中
   子域、path `*` 跨 `/`、`<all_urls>` 限 http(s)、非 http(s) URL 永不命中、非法 pattern 拒载。
3. **grant fail-closed**：声明 `GM_xmlhttpRequest` 的脚本整只拒载并记录；白名单 grant 正常载入。
4. **hash 一致性**：enabled 且 sha 一致 → 服务；文件内容变更 → 停止服务并记录；
   清除 sha256 重新锚定后恢复服务；enabled 无 sha → 扫描时锚定（manifest 被写入当前 hash）。
5. **发现 ≠ 启用**：目录新文件、manifest 无条目 → 不服务。
6. **IPC 契约**：match 只回服务集脚本且回包无文件路径；非法 url / 非法 scriptId / 超长 key /
   不可序列化 value 被拒。子 frame 存储面由 runtime 侧失效（存储函数位 `undefined`，
   调用即 TypeError 被 executeScript 吞掉，请求不会发出）；main 侧 `senderFrame.parent`
   判定保留为纵深防御，当前配置下不可达（行为规则 5）。
7. **GM 存储**：set → get 回读一致；deleteValue 后 get 返回默认值；listValues 返回现存键；
   两个并发 set 不丢更新；单脚本存储超 2 MB 拒绝。
8. **runtime（静态可验证部分 + 纯函数）**：非 http(s) protocol 判定 no-op；frame 幂等守卫
   存在；runAt 归一化；runtime 源码不引入 electron 之外的 Node 内置模块；GM\_\* 以函数参数
   注入而非 window 全局；runtime 引用的 channel 常量与 contract 同源。
9. **fixture 实测项**（2026-10-25 已实测，除标注外全部 PASS；产物 `/tmp/iab-fixture/`）：
   - 断言 A PASS：主世界六个 `GM_*`、runtime 入口标志与 `unsafeWindow` 全 undefined；
     GM\_\* 以函数参数注入，隔离世界同样不挂 window 全局。
   - 断言 B PASS：页面主世界先行设置的 `window.__pageProbe` 隔离世界读不到
     （脚本侧 `GM_setValue` 落盘证据：`typeofPageProbe:"undefined"`，主世界同点实测可见）。
   - 功能链 PASS：GM_addStyle 隐藏 AI Copilot iframe 与 MutationObserver 复活广告节点
     （复活节点同样命中 CSS）；`@run-at document-start` 实测落 `interactive`（match IPC
     一跳延迟，行为规则 6 的已知代价实录）；GM 存储往返（set→硬重载→get）；
     **硬刷新不失效**（立项原始痛点）；销毁/重建 guest 后 preload 自动重放。
   - 快照瘦身实测：`SNAPSHOT_SCRIPT` 注入前后 8163→4945 字节（-39.4%）、elements
     16→8（-50%）、dom 45→37（-17.8%）；ACTION_SEL 命中数不变——收益全部来自快照对
     display:none 的过滤。首屏桥调用计数未插桩，以快照体量为量化代理。
   - 严格 CSP（`script-src 'self'`）下脚本仍生效：隔离世界 `new Function` 不受页面
     CSP 限制（调研未覆盖项，实测确认）。
   - 附加覆盖 PASS：发现≠启用 / 首扫锚定 sha256 / 文件变更 hash 门停服 / 清 sha 重新批准。
   - A③ 真实侧栏实测（2026-10-25，dev renderer 修复后回填）：真实 app 全链路 PASS——
     快照瘦身复现（8160→4944B，-39.4%；elements -50%），收益仍全部来自 display:none
     过滤；preload 经真实销毁/重建路径自动重放（bootCount 连续）。
   - residency 挂起链路说明：挂起/恢复的「真实侧栏路径」当前**无 UI 可达触发点**——
     `browserTabResidencyPolicy` 的唯一触发器是 >32 tab 的 victim 选择，且生产装配
     不注入 `recoveryStore`（`main/index.ts`：「Browser shell/pageState 不跨进程恢复」），
     suspended shell 不可达。等价销毁/重建路径已覆盖断言本体；若未来恢复挂起触发器
     （注入 recoveryStore 或调整 victim 策略），需补真实挂起/恢复 fixture。
   - `@run-at document-start` 实测注记：该时点 `document.documentElement` 可为 null
     （文档仍处 loading 态）——脚本与 `GM_addStyle` 实现都需容忍根节点未就绪，runtime
     的 `appendWhenDocumentReady` 以 MutationObserver 挂载，脚本侧自行操作 DOM 时
     同样需等待根节点出现。
   - 残余：跨域 OOPIF（带真实 `src` 的跨域 iframe）是否收到 session preload 注入
     未实测（行为规则 5 的 fixture 补测项）；首屏桥调用插桩仍缺，快照体量为量化代理。

## P2：agent 工具面 + 确认流 + 设置卡

P1 已随 26.3.0 发布并在 workwin 实机验收通过。P2 在不动 P1 信任门（发现≠启用 /
首扫锚定 sha256 / 内容变更即失活）的前提下，补齐三条运维路径：agent 工具面（BrowserCommand
三命令）、用户确认流（approve-once-per-content 的 UI 化）、设置卡（脚本清单与状态呈现）。

### 行为规则

1. **agent 工具面三命令**（BrowserCommand 判别联合新增三个方法，均不携带 `tabId`——
   userscript 不是 view 作用域命令）：
   - `userscript_list`（无参）：触发一次状态扫描，返回
     `value.scripts: [{ scriptId, name, version?, runAt, grants, match, status, sha256 }]`。
     `match` 是脚本声明的原始 pattern 列表；`status` ∈ `serving | enabled_pending_anchor |
     hash_mismatch | disabled | pending_approval | parse_failed | grant_rejected`；
     `sha256` 是当前文件 hash（hex）。**回包不含脚本代码与任何文件路径**。
   - `userscript_reload`（无参）：触发一次完整扫描（含 P1 锚定语义——对已批准待锚定条目
     写回 manifest），返回与 `userscript_list` 同构的状态列表。P1 无扫描缓存，命令语义是
     「立即重导出事实」而非「失效缓存」，天然幂等；保留它是因为 agent 在用户改完脚本文件后
     需要一个明确的刷新动作语义（与未来若引入缓存时的命令面兼容）。
   - `userscript_set_enabled { scriptId, enabled }`：agent 侧启用请求**不直接启用**（见
     确认流），禁用请求直接生效（降低权限不引入新执行内容）。返回操作后的该脚本状态项——
     与 `userscript_list` 条目同构的嵌套对象 `{ scriptId, changed, status: <状态项> }`，
     状态字符串取 `status.status`（词汇见「状态词汇」），不是裸字符串（契约勘误
     2026-10-28，随 workwin 实机交接确认；实现见 `userscriptService.setAgentEnabled`
     与 `browserCommandUserscriptsHandler` 回包）。

2. **确认流红线（承重语义）**：agent 不得造成「未经用户确认的新内容被执行」。P1 的
   approve-once-per-content = manifest `enabled + sha256` 锚定。P2 采用**方案 (a)：分来源
   的 set_enabled**，论证：
   - **agent 来源识别不需要新机制**：BrowserCommand 的唯一入口是 host 运行时 →
     `runBrowserCommandOnView`（main/index.ts），设置卡从不发 browser 命令，用户对
     manifest 的写路径只有 SettingService patch（经 UI）。因此「命令面来的 set_enabled」
     按构造即 agent 来源，无需在命令上附带 origin 字段（附带反而给了伪造面）。
   - **agent `set_enabled(scriptId, true)`**：只写「待批准」状态——manifest 条目变为
     `{ enabled: false, pendingApproval: true }`（同时清除旧 sha256；对 hash_mismatch
     条目同样如此，失活事实由扫描状态呈现）。除非条目已经处于「enabled 且（无 sha 或
     sha 与当前一致）」的已批准态（此时为幂等 no-op，不写）。**任何情况下该命令都不能让
     一个当前未在服务的脚本进入服务**。
   - **agent `set_enabled(scriptId, false)`**：直接写 `{ enabled: false }`（清 sha 与
     pendingApproval）。禁用是降权，允许 agent 直达。
   - **用户批准（设置卡，M1 修订）**：patch 条目为
     `{ enabled: true, sha256: <liveStatus.sha256> }`——批准即钉住用户所见内容指纹
     （整条目替换，pendingApproval 随之清除），关闭「批准 → 首扫锚定」窗口内 agent
     改文件并 reload 使未确认内容被锚定的红线缺口；其后内容变更落 hash_mismatch 停服，
     批准后未改则 sha 一致直接服务（无首扫锚定写）。**边界**：liveStatus.sha256 为空
     （文件从未成功扫描/读取失败，或无宿主降级行且 manifest 无锚）时「用户所见」无哈希
     可钉，回退 `{ enabled: true }` 首扫锚定——该窗口固有，由扫描语义承接（任何修改
     仍须再次显式批准）。用户拒绝/忽略 = 保持 pendingApproval 或显式 dismiss
     （patch `{ enabled: false }`）。
   - 内容变更后的重新启用路径不变：hash mismatch → 停服（enabled 仍 true 但不服务，
     状态 `hash_mismatch`）→ 用户在设置卡重新批准 → 清 sha → 重锚定。方案 (b)（完全不给
     agent set_enabled）被否决：它同样需要设置卡与状态呈现，省下的只是 pendingApproval
     一个字段，却让 agent 无法表达「建议启用」，用户得手工对照文件名操作。
   - `pendingApproval` 是新 schema 字段（`embeddedBrowserUserscript` 条目
     `{ enabled: boolean; sha256?: string; pendingApproval?: boolean }`，向后兼容，旧条目
     缺省 false）。**服务集判定不看 pendingApproval**：条目 `enabled !== true` 即不服务，
     pendingApproval 条目恒为 enabled=false，fail-closed 不依赖新字段的读取正确性。

3. **设置卡**：挂在浏览器设置区（`BrowserSettingsSection`），不放模型设置区——用户脚本
   是 IAB 分区行为，与「证书策略」「浏览器数据」同域；模型设置区的 VisionBridge 卡是
   provider 能力补偿，语义不同。呈现与动作：
   - 脚本行：scriptId、name（扫描元数据；无扫描数据时缺省 scriptId）、状态徽标
     （serving/enabled/hash-mismatch/disabled/pending-approval/parse-failed/
     grant-rejected/storage-corrupt）、sha256 前 8 位 hex、启停开关。
   - 待批准行：pendingApproval 徽标 + 「批准」按钮（patch `{ enabled: true }`）；开关
     关闭 = dismiss（patch `{ enabled: false }`）。
   - 损坏态：hash mismatch（内容变更）与 storage_corrupt（GM 存储文件损坏，状态查询时
     对有存储文件的脚本做一次读探测）均以状态徽标呈现，不自动修复。
   - 数据来源：开关与批准动作经 `useSettings()` 走 SettingService patch（唯一写路径）；
     实时状态（name/match/当前 hash/损坏态）经可选平台方法
     `IPlatformService.getIabUserscriptStatus?()`（Desktop 经
     `zcode:iab-userscripts-status` invoke → main 状态扫描；Web/无宿主环境不实现——
     卡片降级为 manifest 派生行（enabled + 已锚定 sha 短码），不猜测 name 与
     hash-mismatch）。
   - 状态查询是只读投影：**不做锚定写**（锚定仍只发生在 match 扫描路径），避免「打开
     设置页」成为隐藏的批准动作。
   - 三语文案（zh-CN / en-US / fa）。

4. **desktop main 装配**：
   - 命令 handler 在 `browserView/browserCommandUserscriptsHandler.ts`（照 cookies
     handler 先例）：识别三个 userscript 方法，经 userscript 服务端口执行；未安装
     （`installIabUserscripts` 未跑）返回 `backend_unavailable`。接入点在
     `runBrowserCommandOnView`（main/index.ts）顶部——不进 `browserGuestManager`
     （userscript 不是 tab/view 作用域命令，且该文件不在本次改动面）。
   - `userscriptService` 扩展命令面方法：`listStatus()`（只读状态投影）、
     `reload()`（扫描 + 锚定，P1 语义）、`setAgentEnabled(scriptId, enabled)`
     （确认流状态机）。状态扫描的共享内部与 `scan()` 同源（同一份 parse + manifest
     判定），不引第二状态所有者。
   - 服务实例经 bootstrap 的 `getIabUserscriptService()` 暴露（未安装返回 null）。
   - 日志：`createServiceLogger("userscripts")`（main 进程）。

### 状态词汇（status 联合，命令回包与设置卡共用）

`serving`（enabled ∧ 已锚定 ∧ hash 一致）｜`enabled_pending_anchor`（enabled 无 sha，
下次扫描锚定；仅在批准后未扫描的窗口可见）｜`hash_mismatch`（enabled 但内容变更失活）｜
`disabled`（无条目或 enabled=false 且无 pendingApproval）｜`pending_approval`（agent
请求启用待用户批准）｜`parse_failed` / `grant_rejected`（静态校验拒载）。
优先级：静态拒载 > manifest 状态。

### 验收场景（P2）

1. **命令 schema 边界**：三个命令 strict（未知字段拒）；`userscript_set_enabled` 空
   scriptId 拒、enabled 非布尔拒；list/reload 带额外字段拒。
2. **agent set_enabled 进待批准不执行**：manifest 无条目 + agent set_enabled(true) →
   条目 `{enabled:false, pendingApproval:true}`，match 扫描服务集不含该脚本；对
   hash_mismatch 条目执行同样只落 pendingApproval。
3. **用户批准后执行**：pendingApproval 条目 → 设置卡批准（patch
   `{enabled:true, sha256:<所见>}`）→ 文件未改即直接服务（sha 一致，无首扫锚定写）；
   批准后文件被改 → `hash_mismatch` 停服，未确认内容不被锚定（M1）。
4. **hash mismatch 停服后 UI 呈现**：已锚定脚本文件内容变更 → 状态 `hash_mismatch`、
   不服务；设置卡显示对应徽标；用户重新批准后恢复。
5. **reload 幂等**：连续两次 reload 返回同构状态，manifest 不因 reload 产生额外写
   （除批准后首扫锚定的一次性写）。
6. **agent 禁用直达**：agent set_enabled(false) → 条目 enabled=false，立即不服务。
7. **状态查询只读**：getIabUserscriptStatus 对 enabled 无 sha 条目不做锚定写（返回
   `enabled_pending_anchor`），锚定仍只由 match 扫描完成。
8. **未安装降级**：`installIabUserscripts` 未执行时三个命令返回 `backend_unavailable`。
9. **设置卡**：manifest 派生行（无平台方法时）不显示 name/mismatch 猜测；批准/开关
   patch 只经 SettingService；三语文案齐备。
10. **schema 不变量（M4）**：条目 schema superRefine 强制 `pendingApproval:true ⇒
    enabled:false`；违禁组合（含手改设置文件的旁路写入）整条目拒绝并经 catch 降级
    禁用，不连累整份设置文件解析；storage 与 patch 两条登记路径同矩阵放行/拒绝。

### P2 明确不做

- 不给 agent 任何「批准」能力（pendingApproval 只能由用户在设置卡转正）。
- 不做脚本安装/下载/编辑 UI（脚本文件仍由用户手工放入 `~/.yazcode/userscripts`）。
- 不做 guest IPC 面扩张（仍是恰好 3 个 channel）；preload 的 `console.warn` 经 IPC
  转发 main 日志（m2-3）涉及第 4 个 channel 的契约修订，留待后续。
- 不做 fs.watch / 缓存（reload 命令的存在不改变「每次请求全量重扫」的 P1 架构）。

## P3：管理界面（实战反馈驱动）

需求来源：workwin 侧 agent 实机使用 P1/P2 后交回的交接说明（第七节「userscripts 管理界面」）。
数据面在 P2 已完整，P3 **只做呈现升级 + 一个新运行时事实**，不改信任门、不扩命令面、
不动 guest IPC。

### 行为规则

1. **列表化设置卡**（升级 `IabUserscriptsSettingsCard`，不重建）：每行固定呈现
   名称 + 版本（有则显示）+ 状态徽标 + `@match` 域名列表 + 最后注入时间 + 启停开关。
   - `@match` 域名由声明 pattern 派生展示（去 scheme 与 path，去重，保序）；`<all_urls>`
     原样显示，`*.example.com` 保留通配前缀。纯函数在投影层实现，不做 URL 解析以外
     的猜测（回包本就不含端口，pattern 编译期已拒绝带端口 host）。
   - 静态拒载行（`parse_failed` / `grant_rejected`）的 `match` 为空，域名区以
     `detail` 代替展示——这是用户自查「为什么进不了待批准流程」的唯一线索。

2. **状态语义可视化**（颜色即语义，`DESIGN.md` 语义色 token）：
   `serving` 绿（success）｜`pending_approval` 黄（warning）｜`hash_mismatch` 红
   （destructive）｜`parse_failed` / `grant_rejected` / `storage_corrupt` 红
   （destructive）｜`enabled` / `disabled` 灰（surface）。不为「好看」借用语义色：
   灰色只用于「无活动状态」的两种。

3. **待批准置顶栏**：`pending_approval` 行**不混在普通列表里**，单独成组置顶渲染
   （分区标题 + 每行「批准」主按钮 + 驳回开关）。置顶是呈现层分区，不是排序：
   底层仍是同一份状态列表，不引入第二份状态。分区由投影层纯函数给出
   （`pending` / `others`），保证可测。

4. **`hash_mismatch` 重新批准**：该行徽标红色且带「重新批准」按钮，与待批准按钮同
   一条用户批准路径（patch `{ enabled: true, sha256: <所见 hash> }`，M1 语义不变）。
   这是 P2 设置卡未覆盖的动作（P2 只有待批准行有批准按钮），P3 补上。

5. **中文状态标签**（三语同步 zh-CN / en-US / fa）：
   服务中 / 待批准 / 哈希失配 / 解析失败 / 已禁用（P2 已有文案改为该词汇：
   serving 生效中→服务中、hashMismatch 内容已变更→哈希失配、parseFailed 格式错误→
   解析失败、disabled 已停用→已禁用）；`enabled` / `grant_rejected` / `storage_corrupt`
   保留既有文案。

6. **`lastInjectedAt`（运行时新增字段）**：
   - **所有者**：main `userscriptService` 的内存表 `Map<scriptId, epochMs>`——注入时刻
     是「本进程实际服务过」的运行时事实，不属于脚本文件事实（store 不持有），
     也不属于用户决策（manifest 不持有），因此不能落盘成第二份状态。
   - **写路径唯一**：`match` 命令对**实际返回给该 frame 的服务集条**逐条记录当前时间
     （`Date.now()`）；不是 match 命中的近似值，也不是「上次扫描」时间。同一脚本多
     frame 注入时后写覆盖（值语义 = 最近一次实际注入）。
   - **读路径**：`listStatus()` / `statusOverview()` / `reload()` / `setAgentEnabled()`
     回包在状态项上合并 `lastInjectedAt`（无记录则字段缺席，不写 `null`/0，避免
     「1970 年注入」这类假事实）。合并口径统一，agent 侧同一类型不会出现两种形状；
     内存表裁剪只发生在 `inspect` 系列出口（`listStatus` / `statusOverview` / `reload`）。
   - **生命周期**：纯内存，**进程重启即清零**（应用重启后所有行回到「尚未注入」直到
     下次导航）。这是刻意取舍：注入时刻是进程内观测事实，落盘要引入时钟/时钟漂移
     与第二个所有者。设置卡对缺席值显示「尚未注入」占位，不显示时间。
   - **类型镜像链**：`packages/shared` `IabUserscriptStatusItem.lastInjectedAt?: number`
     → `apps/zcode-cli/packages/contracts` `BrowserUserscriptStatusItem.lastInjectedAt?: number`
     （与现有 status 词汇镜像同一模式）。`userscript_list` / `userscript_reload` 回包
     同时带上该字段（agent 也能看到「最近注入」这一事实）。
   - **内存表有界**：`inspect` / `statusOverview` 时按当前扫描出的 scriptId 集合裁剪，
     已删除脚本不留残留条目。

7. **每行开关（P2 确认流语义不变）**：开 = 用户批准（patch 钉住所见 sha256），
   关 = 禁用/驳回（patch `{ enabled: false }`，立即降级）。**设置卡不走 browser
   命令面**：agent 的 `userscript_set_enabled` 由 main 按「命令面即 agent 来源」识别，
   设置卡若复用它会让「用户点开」被当成 agent 请求而永远停在 pending_approval。
   因此开关的语义等价于 `setEnabled` 的用户侧版本，实现仍是 SettingService patch
   唯一写路径（P2 规则 3 不变）。

8. **不做脚本编辑器**：`@match` 带端口会 `parse_failed` 是实战踩坑，卡片对
   `parse_failed` 行露出 `detail`（如 `invalid @match pattern: http://127.0.0.1:8642/*`）
   供用户自查即可，不提供在线编辑或格式修正。

### 状态所有者（P3 增量）

| 状态 | 所有者 | 说明 |
| --- | --- | --- |
| 注入时刻（`lastInjectedAt`） | main `userscriptService` 内存表 | 唯一写者是 `match` 命令成功回包路径；唯一读出口是 `listStatus` / `statusOverview`。重启清零，不落盘（见行为规则 6）。 |
| 卡片分区（待批准 / 其余） | `iabUserscriptsCardPresentation.ts` 纯投影 | 由同一份状态列表派生，不缓存、不持有第二份状态。 |

事件顺序（注入时刻写入）：

```
guest frame 导航 → runtime invoke(match)
  → main 重扫 → 计算服务集 → **对每个实际返回的 script 记 now**
  → 回包 → runtime 逐脚本注入（runAt 等待后执行）
设置卡打开 / 刷新 → getIabUserscriptStatus → service.statusOverview()
  → store.inspect()（文件+manifest 事实）+ 内存表合并 → 回包（含 lastInjectedAt）
```

注意：记录点是**回包**而非脚本执行完成——`document-end` / `document-idle` 脚本的
回包先于实际执行，因此该值是「最近一次开始服务」的时刻，不是「执行完成」时刻
（语义边界写入类型注释）。

### 验收场景（P3）

1. **`lastInjectedAt` 写读链**：`match` 命中脚本后 `listStatus()` / `statusOverview()`
   带出该脚本的 `lastInjectedAt`（≈ match 时刻）；未命中/未服务的脚本该字段缺席；
   两次 match 后取较新值（覆盖而非累加）。
2. **重启清零**：新建 service 实例（模拟重启）后所有脚本 `lastInjectedAt` 缺席，
   状态卡显示「尚未注入」占位。
3. **内存表裁剪**：脚本文件删除后再 `inspect`，内存表不再保留该 scriptId 的条目。
4. **投影分区**：`buildIabUserscriptRows` 之后的分区函数把 `pending_approval` 单独
   归入 `pending`，其余进 `others`；两边都不丢行、不重复。
5. **徽标语义**：serving→success、pending_approval→warning、hash_mismatch /
   parse_failed / grant_rejected / storage_corrupt→destructive、enabled / disabled→surface。
6. **`@match` 域名派生**：`https://oa.test/*` → `oa.test`；`*://*.example.com/path*` →
   `*.example.com`；`<all_urls>` 原样；多条去重保序；`parse_failed` 行走 `detail`。
7. **重新批准入口**：`hash_mismatch` 行渲染「重新批准」按钮，点击后 patch
   `{ enabled: true, sha256: <当前文件 hash> }`（复用 `nextManifestEntry("approve")`），
   状态回到 serving（下次扫描）。
8. **三语齐备**：新增/改写的状态与分区文案在 zh-CN / en-US / fa 三份 locale 同时存在，
   key 集合一致。
9. **类型镜像一致**：`shared.IabUserscriptStatusItem` 与
   `contracts.BrowserUserscriptStatusItem` 均含可选 `lastInjectedAt: number`，且
   `browser-client` 回包透传（agent 侧不校验该字段非空）。

### P3 明确不做

- 脚本编辑器 / 在线创建 / 格式自动修正（脚本仍是用户或 agent 落盘的文件）。
- 注入**计数**（每 frame 计数会放大数字并误导用户；只给最近注入时刻）。
- 把 `lastInjectedAt` 落盘或跨进程共享（重启清零是明确的取舍，见行为规则 6）。
- 扩展命令面 / guest IPC / 新增 IPC channel（仍是 3 个 guest channel +
  既有 `zcode:iab-userscripts-status`）。

## P4：自助管理（新建 / 导入 / 从 URL 安装 / 编辑 / 删除）

P3 把管理界面做成了「只读列表 + 批准」。P4 补上**写能力**：用户不再只能手工把文件放进
`~/.yazcode/userscripts`。产品形态（用户已拍板）是**设置卡内展开**——行点开展开详情与
编辑器，工具行给三个入口，不新增导航页。

P4 只扩「用户如何把脚本放进来」，**不动执行信任门**：approve-once-per-content、grant
fail-closed、`@match` 编译校验、GM 存储上限全部沿用 P1/P2。

### 承重红线（逐条对应验收场景）

1. **落盘 ≠ 批准**。任何写盘路径（新建 / 导入 / URL 安装 / 编辑保存）都**不得**让内容
   进入服务集。写入后脚本只能落在两个状态之一：
   - `pending_approval`（新建、或覆盖一个此前未启用的脚本）：UI 在写盘成功后 patch
     manifest 为 `{ enabled: false, pendingApproval: true }`；
   - `hash_mismatch`（覆盖一个已批准脚本）：**不 patch manifest**，旧 `enabled + sha256`
     原样保留，扫描自然得到 hash 不一致而停服，走 P3 的「重新批准」入口。
   唯一放行路径仍是设置卡的批准按钮（`nextManifestEntry("approve", 所见 sha)`）。
2. **保存动作永不写 sha256**。任何写盘路径都不得写 `{enabled:true, sha256:…}` 组合——
   那是批准语义，只有批准按钮能产生。
3. **从 URL 安装三段确认，任一步都不得落盘**：
   - 段 1 **拉取**：main 发 HTTP（https-only、20 MB 上限、20 s 超时、`redirect: "manual"`
     且 ≤5 跳、每跳重新校验协议与地址；SSRF 防护与 `desktopSaveFile` 同一套 BlockList +
     DNS 钉扎连接），返回 `{ source, preview }`，**不写文件**；
   - 段 2 **预览**：渲染解析出的 `name / version / runAt / grants / match` + 源码预览，
     用户在此看到将要安装什么；
   - 段 3 **安装**：用户点「安装」才调用写盘通道，落 `pending_approval`。
   - 静态校验不通过的源码（`parse_failed` / `grant_rejected`）**在段 2 阻断安装**并显示
     `detail`：这两种状态永远不会执行，安装只会留一条永久惰性的噪音行；repair 走编辑器。
4. **路径边界**：脚本只能写 `~/.yazcode/userscripts/<scriptId>.user.js`。scriptId 由
   UI 给出，main 在写盘前校验（无路径分隔符、非 `.`/`..`、无 Windows 非法字符、不以
   `.` 开头或空格/点结尾、长度 ≤64）；拼接后仍以「解析出的绝对路径必须落在脚本目录内」
   二次确认。单文件上限 2 MB。
5. **重名必须显式覆盖**：写盘通道带 `overwrite` 布尔。目标已存在且 `overwrite !== true`
   时返回 `exists` 失败，UI 弹「覆盖 / 另存」；覆盖前把旧内容存一份
   `<scriptId>.user.js.bak`（单代，覆盖即换；`.bak` 不以 `.user.js` 结尾，扫描器天然忽略）。
6. **删除双确认**：删除 = 删文件 + 清 manifest 条目 + 删 GM 存储。用户侧顺序是
   **先降权再销毁**：确认框 → patch manifest 移除该条目（该步失败即中止，不留「文件没了
   但 manifest 还写着 enabled」的中间态）→ 调删除通道。存在 GM 存储文件时**第二个
   确认框**独立出现，文案明示「该脚本的存储数据将一并删除」，取消 = 只删脚本文件、保留
   存储（`deleteStorage: false`）。

### 行为规则

1. **写路径分工（不新增第二状态所有者）**：
   | 事实 | 所有者 | 写者 |
   | --- | --- | --- |
   | 脚本文件内容 | 文件系统 | main 的写盘通道（本 P4 新增） |
   | GM 存储 | 文件系统（per-scriptId JSON） | main 的删除通道（仅 deletion） |
   | manifest（enabled/sha256/pendingApproval） | `AppSettings`（SettingService） | **仍是 UI 的 SettingService patch**；main 只在 agent 命令面经 port 写 |

   顺序固定为「先写文件、后 patch manifest」（新建/编辑），「先 patch、后删文件」（删除）：
   任一中间态都是 fail-closed（无条目 = 不服务；条目 enabled 但文件不在 = 无状态行）。

2. **新增 IPC 面（renderer → main 的宿主通道，不是 guest 面）**：guest 的 3 个 channel
   仍是恰好 3 个，P4 一个都不碰。新增的是 `PlatformChannels` 上的宿主 invoke：
   - `IabUserscriptsRead { scriptId }` → `{ ok, content }`（编辑前读当前文件）
   - `IabUserscriptsWrite { scriptId, content, overwrite }` →
     `{ ok, changed, scriptId, sha256 }` / 失败码 `invalid_script_id | invalid_content |
     too_large | exists | write_failed`
   - `IabUserscriptsDelete { scriptId, deleteStorage }` →
     `{ ok, deletedFile, deletedStorage }` / 失败码 `invalid_script_id | unknown_script | delete_failed`
   - `IabUserscriptsFetchSource { url }` → `{ ok, source, preview }` /
     失败码 `invalid_url | not_https | too_large | timeout | remote_address_not_allowed |
     download_failed`
   契约类型放 `packages/shared/src/platform.ts`（与 `IabUserscriptStatusItem` 同处），
   `apps/zcode-cli/packages/contracts` **不镜像**——这四个是桌面本地文件能力，agent
   工具面拿不到（见规则 6）。
   - `preview` 形状：`{ name, version?, runAt, grants, match, parseError? }`，
     由 main 复用 `buildUserScriptDef` 的同一套解析得出，保证「预览所见 = 安装后扫描所得」。

3. **写盘通道的实现边界**：`packages/desktop/src/main/userscripts/userscriptFiles.ts`
   （electron-free，测试可直跑）提供 `readScript / writeScript / deleteScript`，
   注入 `scriptsDir` 与 storage 端口；scriptId 校验函数与 storage 共用同一份
   （从 `userscriptStorage.ts` 提到 `userscriptRules.ts` 的 `isValidUserScriptId`，
   两处引用同一实现，不复制规则）。

4. **URL 拉取的实现边界**：`userscriptUrlInstall.ts`（electron-free）导出
   `fetchUserscriptSource(url, deps)`，`deps` 注入 `fetchImpl` / `lookup` 以便测试。
   SSRF 守卫从 `desktopSaveFile.ts` 提取为 `remoteFetchGuard.ts`
   （`blockedRemoteAddresses` + `resolvePublicAddresses` + 钉扎 lookup），
   `desktopSaveFile` 改为引用它，**行为不变**（仍 http+https、5 跳）；P4 传
   `allowedProtocols: ["https:"]`、`maxRedirects: 5`、`maxBytes: 20MB`、`timeoutMs: 20000`。

5. **UI 结构**（文件都 ≤400 行，超出即拆）：
   - 工具行：`新建` / `导入` / `从 URL 安装` 三个按钮，只有 `statusAvailable`（桌面宿主）
     时渲染；无宿主环境保持 P3 的只读降级。
   - 行展开：点行体展开详情面板——元数据（scriptId/name/version/runAt/grants/@match/
     sha256 短码/最后注入）、`detail` 原文、`Textarea` 编辑器（mono 字体）、
     操作按钮（保存 / 重新批准 / 删除）。**编辑器用 `Textarea` 兜底**：本仓无
     CodeMirror/Monaco，`@pierre/diffs` 的 CodeViewer 是只读渲染器，接编辑需要引入
     新依赖（P4 明确不加），记为后续增强。
   - 导入：`<input type="file" accept=".user.js">` 由渲染进程 `file.text()` 读内容
     （不扩 main 的任意路径读面），scriptId 取文件名 stem，随后与「新建」共用同一
     编辑/保存流程。
   - URL 安装：三段式对话框（输入 URL → 拉取并展示元数据 + 源码预览 → 安装）。
   - 三语文案（zh-CN / en-US / fa）齐备。
   - 新建模板注释里写明合法 `@match` 示例（裸 host，不带端口）与「脚本按 frame 注入」
     两个实战要点。

6. **agent 面刻意不扩**：P4 不新增 BrowserCommand，agent 仍只有 P2 的
   `userscript_list / reload / set_enabled`（观察 + 请求批准）。写文件、装 URL、删脚本
   只能由用户在界面操作——这与「agent 不得造成未确认内容被执行」同源：也不让 agent
   造成未确认内容被写入。

### 状态所有者（P4 增量）

| 状态 | 所有者 | 说明 |
| --- | --- | --- |
| 脚本文件内容 | 文件系统；写者 = main 写盘通道 | 只写 `<scriptsDir>/<scriptId>.user.js`；覆盖留单代 `.bak` |
| 覆盖前的旧内容 | 文件系统 `<scriptId>.user.js.bak` | 单代、非 `.user.js` 后缀、不参与扫描；用户可手工回收 |
| URL 拉取的临时内容 | **不落盘** | 段 1 只在内存里返回；安装时才写文件 |

事件顺序（新建 / URL 安装）：

```
用户填写或粘贴 → [URL 时] main 拉取 + 解析预览（不落盘）→ 用户确认安装
  → main 写 <scriptId>.user.js（超过 2MB / 非法 id / 未确认覆盖 → 拒绝）
  → UI patch manifest { enabled:false, pendingApproval:true }
  → refreshStatus → 行出现在「待批准」分区
  → 用户点「批准」→ patch { enabled:true, sha256:<所见> } → 下次 match 起服务
```

事件顺序（编辑已批准脚本）：

```
展开行读到当前内容 → 用户改动 → 保存
  → main 写文件（留 .bak）→ **不 patch manifest**
  → refreshStatus → 状态 hash_mismatch → 用户点「重新批准」才恢复服务
```

### 验收场景（P4）

1. **新建全生命周期**：新建 → 写盘成功 → manifest `{enabled:false, pendingApproval:true}`
   → 状态 `pending_approval` 且在待批准分区 → 批准 → 下次扫描 `serving` → match 注入。
   写盘后到批准前，match 服务集**不含**该脚本。
2. **保存永不写 sha**：新建/导入/编辑三条路径产生的 manifest 条目都不含
   `{enabled:true, sha256}` 组合（测试断言 manifest 快照）。
3. **编辑已批准脚本 → hash_mismatch**：对 `serving` 脚本保存新内容 → manifest 不变
   （仍 enabled + 旧 sha）→ 状态 `hash_mismatch`、不服务 → 重新批准后 `serving`。
4. **导入重名**：目标文件已存在且 `overwrite:false` → `exists` 失败、文件未被改动；
   `overwrite:true` → 内容替换且生成 `.bak`，`.bak` 不出现在状态列表里。
5. **scriptId 校验**：`../evil`、`a/b`、`a\\b`、`.`、`..`、`.hidden`、`name.`、
   `con:`、超长 id、空串全部拒绝（`invalid_script_id`），且不产生任何文件。
6. **大小上限**：>2 MB 内容拒绝（`too_large`），不写文件、不留半写文件。
7. **URL 安装三段确认**：段 1 返回 source+preview 且磁盘无新文件；段 2 展示
   name/version/grants/match；段 3 写盘后状态 `pending_approval`。任一段中断（用户取消）
   都不产生文件。
8. **URL 安全边界**：`http://` 拒绝（`not_https`）；`http://127.0.0.1/…` 与
   `https://10.0.0.1/…` 拒绝（`remote_address_not_allowed`）；超过 20 MB 拒绝
   （`too_large`，含 chunked 无 content-length 的边读边计数）；重定向到非公网/非 https
   地址拒绝；超时返回 `timeout`。
9. **URL 预览与安装一致**：preview 的 `grants`/`match` 与安装后 `list()` 的对应字段一致；
   声明白名单外 grant 的源码在段 2 被阻断（不进入段 3）。
10. **删除双确认**：删脚本 → manifest 条目消失 + 文件消失；有 GM 存储时出现第二个
    确认框，确认 → 存储文件消失；取消 → 存储文件仍在且状态行已消失（`deleteStorage:false`）。
11. **删除顺序**：manifest 移除失败时中止、文件保留（测试用抛错的 manifest patch 模拟）。
12. **无宿主降级**：`getIabUserscriptStatus` 缺席（Web）时三个工具按钮不渲染，卡片行为
    与 P3 一致。
13. **guest 面不变**：`USERSCRIPT_IPC_CHANNELS` 仍恰好 3 个；新增的都是
    `PlatformChannels` 宿主通道。
14. **三语齐备**：新增文案在 zh-CN / en-US / fa 三份 locale 同时存在，key 集合一致。

### P4 明确不做

- 脚本市场 / 在线仓库检索（Violentmonkey 的脚本源检索）。
- 语法高亮编辑器 / 引入 CodeMirror、Monaco 等新依赖（`Textarea` + mono 兜底，
  记为后续增强）。
- `GM_xmlhttpRequest`、子 frame 存储（维持 P1 边界）。
- agent 的写/删命令（写文件只走用户界面，见行为规则 6）。
- saved-workflow/G1 相关文件、`browserGuestManager.ts`、`third-party/`、根 `package.json`。
