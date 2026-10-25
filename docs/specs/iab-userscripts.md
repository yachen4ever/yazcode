# Spec：IAB 内置用户脚本（monkey 类）P1——分区级 preload

## 背景

内嵌浏览器（IAB，`persist:zcode-embedded-browser` partition）按站点固定注入脚本/CSS 的能力缺口：
页面级优化（隐藏垃圾面板、简化门户元素）目前只能靠命令式 `executeJavaScript` 临时补丁，
硬刷新即失效。本 spec 定义 P1 最小可用能力：应用内置一个 preload runtime，扫描用户脚本目录，
按 `@match` 在 document_start 把「启用且校验通过」的脚本注入 IAB guest 的隔离上下文，
并提供 GM_* 最小集 shim。调研结论见 m5air 调研报告（路线 1：分区级 preload）与
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
     （approve-once-per-content UI）替换这一手工路径，语义不变。

3. **grant fail-closed**（回执硬性要求 ③）：仅接受
   `none / GM_addStyle / GM_getValue / GM_setValue / GM_deleteValue / GM_listValues`。
   脚本声明了白名单之外的 grant（如 `GM_xmlhttpRequest`）：整只脚本拒载（不入服务集）
   并记录一条日志，不静默降级、不裁剪 grant 后继续加载。`GM_info` 不需要声明，恒可用。

4. **@match 匹配**：Chrome match pattern 语义的 http(s) 子集——
   `scheme://host/path`，scheme ∈ {`http`, `https`, `*`}（`*` = http 或 https）；host 支持
   精确、`*`（任意）与 `*.example.com`（含自身与子域）；path 以 `/` 开头，`*` 匹配任意字符
   （含 `/`）；`<all_urls>` 视为 `*://*/` + 任意 path，仍限定 http(s)。非法 pattern 按解析失败
   处理（该脚本不入服务集并记录）。非 http(s) URL 永不匹配任何 pattern。

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
   - runtime 在每个 frame（主/子）的 document_start 注入一次；按 frame 幂等（重复执行
     守卫）；**仅主 frame 提供 GM 存储**，子 frame 只有 `GM_info` / `GM_addStyle`
     （避免 iframe 抢写共享存储）。主 frame 判定以 main 侧 `event.senderFrame` 为准，
     不信任 renderer 传参。
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

7. **GM_* 语义**：`GM_info`（脚本元数据对象）、`GM_addStyle(css)`（向当前文档插入 `<style>`，
   document_start 时 head 未就绪则挂到 documentElement 或延迟到 DOMContentLoaded）、
   `GM_getValue(key, defaultValue?)`、`GM_setValue(key, value)`、`GM_deleteValue(key)`、
   `GM_listValues()`。GM_* 以脚本函数参数注入（不是 window 全局），页面世界物理不可见。
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

| 状态 | 所有者 | 说明 |
| --- | --- | --- |
| manifest（enabled/sha256） | `AppSettings.embeddedBrowserUserscripts`（SettingService 唯一写路径） | **论证**：回执要求复用现有设置存储、避免自建第二份状态文件（两套状态所有者）。AppSettings 是桌面端应用级持久状态的唯一所有者，`visionFallback` 字段已有同模式先例（storage schema + patch schema + 类型三处登记）。store 不直接落盘，经注入的 manifest 端口（生产实现包 SettingService）读写，测试可替换。 |
| 脚本文件 | 用户（`~/.yazcode/userscripts/`） | store 只读扫描，永不写脚本文件；用户级资产，跨 workspace 同源，站内作用域用 `@match` 表达。 |
| GM 运行时数据 | main 侧 userscriptStorage（per-scriptId JSON 文件） | 唯一写者是 main 的 IPC handler；preload 只经 IPC 读写。与 manifest 分离：前者是脚本运行时数据（跟随数据根），后者是用户决策（跟随设置）。 |
| runtime 本体 | app bundle（tsup preload entry → `out/preload/userscriptRuntime.cjs`） | 可信应用代码；路径解析与既有 preload 一致（dev/打包同构），不做数据目录写入。 |
| 扫描缓存 | 无 | store 每次匹配请求全量重扫（目录规模为个位数文件、KB 级，重扫同时天然完成 hash 一致性复核）；不做 TTL/事件订阅缓存，避免第二个状态所有者。 |

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
   不可序列化 value 被拒；子 frame（main 侧 `senderFrame.parent` 判定）的存储请求被拒。
7. **GM 存储**：set → get 回读一致；deleteValue 后 get 返回默认值；listValues 返回现存键；
   两个并发 set 不丢更新；单脚本存储超 2 MB 拒绝。
8. **runtime（静态可验证部分 + 纯函数）**：非 http(s) protocol 判定 no-op；frame 幂等守卫
   存在；runAt 归一化；runtime 源码不引入 electron 之外的 Node 内置模块；GM_* 以函数参数
   注入而非 window 全局；runtime 引用的 channel 常量与 contract 同源。
9. **fixture 实测项**（P1 完成后本地 fixture 前后对比，不阻塞本 spec 的实现合入）：
   - 隔离上下文断言 A（页面摸不到 GM_*）与断言 B（runtime 拿不到页面 JS 变量）；
   - 挂起/恢复后 preload 仍自动生效（销毁/重建 guest 不需要重新注册）;
   - 仿数据门户 fixture（AI Copilot 同款 iframe + MutationObserver 复活节点）：
     隐藏脚本生效后快照 elements[]/dom[] 瘦身、硬刷新不复活、首屏桥调用次数下降。
   - 实测步骤建议：`pnpm dev:desktop` + 本地 fixture 页（`http://127.0.0.1`）；在
     `~/.yazcode/userscripts/` 放入测试脚本并按行为规则 2 手工启用；CDP 连接 guest
     webContents 分别在主世界与隔离世界执行探测脚本取断言值；对比注入前后的
     `SNAPSHOT_SCRIPT` 快照字节/元素数与桥调用计数。
