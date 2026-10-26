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

- **装配**：`packages/desktop/src/main/userscripts/userscriptIpc.ts` 导出
  `installIabUserscripts({ logger })`（注册 preload + IPC channel），由 `main/index.ts` 的
  `app.whenReady()` 调用（`registerIabDownloadAutoSave` 邻近）。
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
     确认流），禁用请求直接生效（降低权限不引入新执行内容）。返回操作后的该脚本状态。

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
