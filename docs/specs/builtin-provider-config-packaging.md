# Spec：ZCode Built-in Provider 配置的打包事实源锁定

## 背景

mint 第二轮双盲测试（v26.5.2 Linux AppImage）报告 F1：设置页「Bundled 与 Active ZCode
Built-in Release 均不可用」，浏览器控制开关 disabled、模型设置不可用，应用日志栈重复
指向 `parseZCodeBuiltinProviderConfigRules` / `decodeZCodeBuiltinRelease` /
`readReleaseCandidate` / `NodeZCodeBuiltinProviderConfigSource.read`。

调查结论（基于 v26.5.2 提交面）：

1. **不是 AppImage 漏打资产**。electron-builder 的 `extraResources` 中
   `config/provider/zcode-builtin.json` 条目位于顶层无平台条件的清单里
   （`packages/desktop/electron-builder.config.js`），mac(dmg/zip) / win(nsis) /
   linux(AppImage+deb) 三平台共用同一入口 `pnpm bundle:desktop`，配置层无差异。
2. 日志栈含 parse/decode 帧，说明包内文件**存在但解码失败**（文件缺失时
   `readReleaseCandidate` 返回 null，AggregateError 内层错误为空）。
3. 真实根因：**electron-builder 主配置链路是全仓唯一未清洗宿主环境注入的
   builtin 配置消费方**。宿主 CLI（在 ZCode 会话内开发/构建）会向子进程注入
   `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`（新名 `YAZCODE_BUILTIN_PROVIDER_CONFIG_FILE`，
   见 `docs/specs/p1a-external-env-renames.md`）指向宿主运行时副本；其 schema 可能
   比仓库解析器新。`electron-builder.config.js` 顶层 `loadBuiltinProviderConfig()`
   直接读 `process.env`，`extraResources.from = builtinProviderConfig.sourcePath`
   被指到宿主副本，打出「宿主 schema 内容 + 仓库旧解析器」的包；运行时
   `NodeZCodeBuiltinProviderConfigSource.read` 解码 ZodError，Bundled 与 Active
   缺省同路径（装配不传 `activeFilePath`）→ 双失败 →「均不可用」。
4. 仓库已有同型事故记载与防护，但未覆盖本链路：
   - `packages/desktop/test/electronBuilderDmgLayout.test.ts` 头注释记载同一注入坑
     （仅防测试自身导入失败）；
   - `apps/zcode-cli/packages/cli/scripts/build.mjs` 前缀级 `ZCODE_*` 洗涤（注释记载
     「已发三类事故：builtin 配置路径被指到宿主副本」）覆盖 CLI staged 副本；
   - `scripts/dev-desktop-env.mjs`、`scripts/build-desktop-agent-cli.mjs` 覆盖
     dev/E2E 链；
   - **`electron-builder.config.js`（主配置副本 extraResources）无任何防护**。

## 产品行为

- 正式安装包（三平台）内 `resources/config/provider/zcode-builtin.json` 必须是
  **与该 commit 解析器兼容的仓库事实源**，宿主会话中构建不得改变其来源与内容。
- 运行时 Bundled/Active 双失败时，报错文案保持现状（裸 error.message 透传）；
  本 spec 不改文案，只保证不再发生 schema 漂移类失败。

## 构建契约

1. **唯一事实源**：所有打包产物内的 builtin 配置副本，事实源锁定为仓库
   `config/provider/zcode-builtin.json`。构建期 `loadBuiltinProviderConfig()` 复用
   运行时 `decodeZCodeBuiltinRelease` 校验事实源可解码，校验失败所有平台构建失败
   （既有行为，保持）。
2. **宿主注入隔离**：`electron-builder.config.js` 在加载 builtin 配置前，从自身
   进程环境剔除 `ZCODE_BUILTIN_PROVIDER` / `YAZCODE_BUILTIN_PROVIDER` 前缀的全部
   变量（含 `_CONFIG_FILE`、`_BUNDLED_CONFIG_FILE` 及未来新增同前缀变量）。剔除
   函数集中在 `scripts/builtin-provider-config.mjs` 导出，与
   `scripts/build-desktop-agent-cli.mjs` 的前缀口径一致；只点名该前缀，不影响
   release.yml 合法注入的 `ZCODE_APP_VERSION` / `ZCODE_ENV`（CLI 构建链的 CI 豁免
   洗涤语义不变）。
3. **三平台共用**：该锁定对 mac/win/linux 打包入口统一生效（同一
   `electron-builder.config.js`），不新增平台分支。
4. **开发者显式覆盖通道**：脚本/下游经 `.env` 文件传 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`
   的显式用例（`scripts/builtin-provider-config.mjs` 经 `loadEndpointEnv` 合并
   `.env`）不属于宿主注入，保留其可用性；隔离只针对宿主进程注入的
   `process.env` 层。

## 验收场景

1. 模拟宿主注入：设 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 指向一个 schema 不兼容的
   fixture 文件后导入 `electron-builder.config.js`，`builtinProviderConfig.sourcePath`
   仍解析为仓库 `config/provider/zcode-builtin.json`，内容可 decode
   （`packages/desktop/test` 覆盖）。
2. 干净环境（无注入）构建：行为与修复前一致（事实源、environment 解析均不变）。
3. 既有 DMG 布局测试（其头注释预设 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 的旧
   workaround）在清洗生效后仍通过：清洗删掉预设值后事实源仍解析为同一仓库文件。
