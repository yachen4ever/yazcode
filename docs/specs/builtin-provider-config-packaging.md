# Spec：ZCode Built-in Provider 配置的打包事实源锁定（R2：运行时读取源单一化）

## 背景

mint 三轮双盲（v26.5.2 / v26.5.3 Linux AppImage）报告 F1：设置页「Bundled 与 Active
ZCode Built-in Release 均不可用」，浏览器控制 disabled、模型设置不可用，结构化错误
`providerRules` 第 9 条 `config.access.mode` 不在本仓解析器四枚举
（`"start-plan"|"individual-coding-plan"|"team-coding-plan"|"off-peak"`）内。

**R1（419bab4e）修复未命中真因**。R2 调查结论（y430p 本机实证 + 代码证据）：

1. **运行时真实读取源由 env 决定，优先级高于包内路径**：
   `packages/desktop/src/main/index.ts:1536-1538` 以
   `{ ...hostProcessLocalEnv, ...process.env }` 调用
   `resolveZCodeBuiltinProviderConfigFilePath`（`desktopProviderConfig.ts`），其分支
   顺序是 **env 显式路径 > 打包态 `process.resourcesPath/config/provider/` > dev 态
   appPath**。打包态下 `hostProcessLocalEnv` 为空对象，`process.env` 中的
   `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 直接生效——**优先级高于 R1 锁定的
   extraResources 链，R1 修复被整个绕过**。
2. **mint 的 AppImage 跑在 zcode 宿主会话内**（三轮测试命令均由其本机 zcode agent
   执行，`~/.zcode` 宿主数据在侧）：宿主 CLI 向子进程注入
   `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 指向宿主 runtime 副本
   （形如 `~/.zcode/v2/runtime/provider/<platform>/<version>/endpoint-*/zcode-builtin.json`，
   y430p 本机同路径实证存在）。该副本是 GLM 官方线的 runtime 数据：老版本线
   `providerRules` 多条（mint 报错「第 9 条」吻合）且 `access.mode` 用官方值域，
   仓库解析器枚举不含 → Bundled/Active 同路径双炸（装配不传 activeFilePath，二者
   同源）→「均不可用」。
3. **平台差异解释**：workwin 26.5.2 Windows 包部署验收模型配置可用——部署启动无
   zcode 宿主 env 注入，走 `resourcesPath` 正常链；Linux AppImage 每轮都在
   mint 的宿主会话内启动 → 必炸。与包内容无关（mint 解包三处文件均在）。
4. **构建期同样存在未设防链（y430p 本机亲历复现）**：在 zcode 宿主会话内跑
   `pnpm bundle:desktop -- --os linux`，`prepare:runtime-assets → prepare:remote-assets
→ packages/server build:remote` 链的 `loadBuiltinProviderConfig` 直接吃
   `process.env`，报 `Invalid Built-in Provider config (production):
/Users/yachen/.zcode/v2/runtime/provider/darwin-x86_64/3.17.2/endpoint-…/zcode-builtin.json`
   ——R1 只修了 electron-builder 主配置链，`prepare-prebuilds.mjs`（remote-assets）
   与 SEA 资产链仍是裸消费方。
5. 既有防护盘点：CLI `build.mjs` 前缀级洗涤仅非 CI 生效；R1 的
   `electron-builder.config.js` 清洗只覆盖主配置链；运行时 env 分支无任何防护。

## 产品行为

- **运行时读取源单一化（打包态）**：打包应用内 builtin 配置的唯一读取源是包内
  `resources/config/provider/zcode-builtin.json`（主进程装配链与 host/agent 子进程
  链一致）。外部注入的 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 在打包态不生效——
  用户的启动环境（无论是否在 zcode 宿主会话内）不影响模型配置可用性。
- dev 态保留 env 覆盖能力（`dev-desktop-env.mjs` 已清洗宿主注入，显式传参是调试
  通道）；「Bundled 与 Active 均不可用」报错文案不变。

## 契约

1. **运行时（打包态 env 隔离）**：`resolveZCodeBuiltinProviderConfigFilePath` 在
   `isPackaged` 时忽略 env 显式路径，恒返回
   `resourcesPath/config/provider/zcode-builtin.json`；dev 态行为不变。
2. **构建期单点防御**：`loadBuiltinProviderConfig`（`scripts/builtin-provider-config.mjs`）
   对传入 env 默认执行宿主注入剔除（`stripHostInjectedBuiltinProviderEnv`，
   `ZCODE_BUILTIN_PROVIDER` / `YAZCODE_BUILTIN_PROVIDER` 前缀），覆盖**所有**消费链
   （electron-builder 主配置、remote-assets/prepare-prebuilds、SEA 资产、CLI staged），
   不再依赖各链自行清洗；R1 在 `electron-builder.config.js` 的外层清洗保留为双保险。
   `.env` 文件的显式覆盖通道不受影响（`loadEndpointEnv` 合并在剔除之后）。
3. **包内副本全量校验**：打进包的每个 `zcode-builtin.json` 副本必须经构建期
   `decodeZCodeBuiltinRelease`（运行时同源解析器）校验——extraResources 链（R1 已接）
   与 glm bundle 链（`stageBuiltinProviderConfig` 既有校验）共两处，任何新增副本
   落点必须同步接入校验。
4. **三平台共用**：运行时与构建契约对 mac/win/linux 统一生效，不新增平台分支。

## 验收场景

1. **运行时负向**：注入 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`（指向不存在的路径）+
   `isPackaged: true` → `resolveZCodeBuiltinProviderConfigFilePath` 仍返回包内路径
   （`packages/desktop/test` 覆盖）；`isPackaged: false` 时 env 生效（dev 能力保留）。
2. **构建链负向**：污染 env 对象传入 `loadBuiltinProviderConfig` → 事实源锁定仓库
   文件、decode 通过（`loadBuiltinProviderConfig({ env: 污染对象 })` 单测）。
3. 本机宿主会话内 `pnpm bundle:desktop -- --os linux --arch x64` 可完成构建
   （R2 调查中该路径实测炸点 `packages/server build:remote`，修复后转绿）。
4. 干净环境构建行为不变；既有 DMG 布局测试与 R1 回归测试持续通过。
