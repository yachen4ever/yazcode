# Spec：Browser cookies 工具（get / set，session 注入）

## 背景

内网系统（OA/ITSM）自动化的登录态管理存在缺口：IAB（内嵌浏览器，`persist:zcode-embedded-browser`
partition）裸启动不继承任何登录态，OA 登录必须用户本人操作（量子办公 APP 手机确认 /
短信验证码，agent 无法代办）；OA 会话过期后需要用户在 IAB 里重新手动登录。

与此同时，用户的日常浏览器（Helium，Chromium fork，`--remote-debugging-port=9222` 常驻）
里保持着同一批站点的登录态。CDP 的 `Storage.getCookies` / `Storage.setCookies` 可以在
不触碰浏览器加密存储的前提下读写全量 cookies（含 httpOnly）——IAB 侧经 guest 的
`webContents.debugger`、外部浏览器侧经 browser-use 既有的 `cdp` 后端，两条链路同构。

本 spec 在 browser-use 插件中新增 **cookies 命令**（get / set），使 agent 能够：
把一个浏览器的 cookies 导出为 JSON，再注入另一个浏览器的会话（典型：Helium → IAB，
免手动重登）。

## 行为规则

1. **命令形状**（`browserCommandSchema` 新分支，与 playwright 的 action 风格一致）：

   ```ts
   { method: "cookies", action: { name: "get" } | { name: "set", cookies: BrowserCookieParam[] }, tabId?: string }
   ```

   `BrowserCookieParam`（对齐 CDP `Storage.setCookies` 的 CookieParam）：
   `name`/`value` 必填；`url` 或 `domain+path` 至少一组（refine 校验）；可选
   `expires`（秒级时间戳）、`httpOnly`、`secure`、`sameSite`（Strict/Lax/None）。

2. **结果语义**：
   - `get` → `{ ok: true, value: { cookies: Network.Cookie[] } }`（browser context 全量）。
   - `set` → 逐条调用 `Storage.setCookies`（部分失败可定位），返回
     `{ ok: true, value: { set: number, failed: { index, name, error }[] } }`；全部失败且
     `set === 0` 时仍为 `ok: true`（调用方按 `failed` 判断），不算 turn 失败。
   - httpOnly cookie 必须可写（本能力存在的意义）；同名同域按 CDP 语义覆盖，不要求先清空。

3. **执行面**：
   - `iab` 后端：main 进程经 guest 的 `webContents.debugger`（`ControlledView.cdp.send`）执行
     Storage 域命令——page-level attach 时 `Storage.getCookies` 返回该 partition 的
     browser context 全量 cookies。**需要至少一个打开的 tab**（无 tab 返回
     `backend_unavailable`，与既有风格一致）；不要求特定站点。
   - `cdp` 后端（外部浏览器）：同走 CDP Storage 域，语义一致。
   - `extension` 后端：不支持（`unsupportedByDefaultIn: ["extension"]`；后续可走
     `chrome.cookies` API，本轮不做）。

4. **API 面**：`browser.cookies`（Browser 级，BrowserCookiesAPI：`get()` / `set(cookies)`）。
   cookies 是 partition/browser 级数据，不挂 Tab 级；IAB 实现内部经 active tab 的 view
   执行（实现细节不对 agent 暴露）。

5. **敏感性与安全**：
   - cookies 是会话凭据级数据。工具描述与 docs 必须包含警示：**结果含登录凭据，不要
     写入日志、不要包含在发给无关方的输出里**。
   - 不做自动同步/定时刷新：cookies 操作只由 agent 显式触发。
   - 不读取/不解析外部浏览器的加密 SQLite（CDP 路径已覆盖导出需求）。
   - 域过滤由调用方完成（agent 按 `domain` 字段筛选后再注入），命令本身不做白名单——
     注入目标是用户自己配置的 IAB，与用户手动导入等价。

6. **典型工作流**（写入 docs，作为 agent 配方）：
   1. `browser.select(cdp 后端的外部浏览器)` → `browser.cookies.get()` → 全量 cookies JSON；
   2. `browser.select(iab)` → `browser.cookies.set(按域过滤后的 cookies)`；
   3. 打开目标站点，以页面渲染特征验证登录态（如 OA 的「尊敬的 XXX，您好」门户框架）。
   - OA 会话是否有效以数据接口返回 JSON 为准（HTML 外壳 = 会话死，见 workwin oa-session 技能）。

## 状态所有者

- 命令类型：`packages/shared/src/browser-use/commands.ts`（browserCommandSchema 分支）+
  `command-metadata.ts`（method 枚举）。
- 执行：`packages/desktop/src/main/browserView/browserCommandPageHandlers.ts`（handleCookies）+
  `browserCommandExecutor.ts`（分发）+ `browserGuestManager.ts`（isSideEffecting 含 cookies set）。
- 工具面：`apps/zcode-cli/packages/browser-use-plugin/scripts/browser-client.mjs`
  （BrowserCookiesAPI，挂 `browser.cookies`）。
- 文档：`apps/zcode-cli/packages/browser-use-plugin/docs/browser-cookies.md`。

## 明确不做

- 不做 cookies 的自动同步、定时刷新或持久化备份（agent 显式触发）。
- 不解析外部浏览器加密存储（DPAPI / App-Bound Encryption）——CDP 路径覆盖导出。
- `extension` 后端本轮不支持。
- 不做 cookie 白名单/黑名单（注入目标为用户自己的 IAB，等价手动导入）。

## 验收场景

1. `iab` 后端 `get`：返回 IAB 会话全部 cookies，含 httpOnly 字段。
2. `iab` 后端 `set` 含 httpOnly cookie：写入成功，`get` 回读一致。
3. 非法入参（缺 name/value、url 与 domain+path 皆无）：schema 拒绝；set 中单条非法
   （绕过 schema 的运行时路径）进 `failed` 不影响其他条目。
4. `cdp` 后端（mock CDP）：get/set 同语义。
5. `extension` 后端：报告不支持。
6. IAB 无任何打开的 tab 时：返回 `backend_unavailable`，提示先打开标签页。
7. 真机端到端（Windows 办公机）：Helium(cdp) `get` → IAB `set` → IAB 打开 OA 免登录
   直达门户。
