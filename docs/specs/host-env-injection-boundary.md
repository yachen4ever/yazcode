# Spec：宿主环境注入面边界（deny-by-default）

## 背景

宿主 zcode 环境对 yazcode 构建/运行时的注入污染已四轮反应式修复：

| 轮次                    | 修复                                                        | 触发事故                        |
| ----------------------- | ----------------------------------------------------------- | ------------------------------- |
| 26.2.0                  | 手动清变量                                                  | 26.2.0 首装阻断                 |
| R0                      | CLI 三入口点名洗涤                                          | CLI 三入口                      |
| R1（419bab4e）          | electron-builder 点名 `stripHostInjectedBuiltinProviderEnv` | F1 第一轮（extraResources 链）  |
| R2（fcb2ef1c/aacbea1e） | 运行时单一事实源 + `loadBuiltinProviderConfig` 单点防御     | F1 第二轮（env 优先分支，真因） |

四轮都「有效但未根治」，原因有三：

1. **继承的信任**：代码继承自上游，上游「官方产品消费官方注入」合法；yazcode 是独立
   产品线，注入方（宿主 zcode）不受控且随官方升级变化——`highspeed` 套餐值即官方
   3.17.x 新下发（mint 三轮双盲「第 9 条 access.mode」实证）。
2. **点名式防护 vs 开放集合**：`ZCODE_*` 注入面是开放集合（仓库内 300+ 变量），点名
   必有漏。已实证的漏：R1 的点名只覆盖 `ZCODE_BUILTIN_PROVIDER*`；三处前缀级洗涤只
   匹配 `ZCODE_`（漏 `YAZCODE_`/`ZCODIUM_`）；`dev-desktop-env.mjs` 的点名删除漏改名
   新名。
3. **无总账**：修复散在多个 spec，无注入面全景视图；新增环境消费无评审清单。

本 spec 做系统性收口：一次性盘点（全仓注入面总账）、统一原语（deny-by-default +
白名单）、运行时早期剥离、门禁固化。

## 盘点方法（可复现）

```bash
# 主盘点：环境变量消费点
grep -rnE "(process\.env|env)\[?[\"'\`]?(ZCODE_|YAZCODE_)" \
  packages apps scripts \
  --include=*.ts --include=*.tsx --include=*.js --include=*.mjs --include=*.cjs \
  --include=*.jsx --include=*.json --include=*.yml --include=*.yaml \
  | grep -vE "(^|/)(dist|node_modules|bundled-agents|out|build|coverage|\.next|target)/"
# 补充扫掠：全量字面量（反向判定「是常量不是环境变量」）
grep -rnoE "(ZCODE_|YAZCODE_|ZCODIUM_)[A-Z0-9_]+" packages apps scripts
# 补充扫掠：前缀扫描点
grep -rnE "startsWith\(.*(ZCODE_|YAZCODE_|ZCODIUM_)" packages apps scripts
# 补充扫掠：整体展开点
grep -rnE "\.\.\.process\.env|\.\.\.env\b" packages apps scripts
```

排除基线：`packages/desktop/mock-cdn/releases/3.17.2/server/zcode-server.cjs` 是预构建
产物（非源码），其命中不计入总账。

**盘点结论**：31 个文件、61 处环境消费点；另有 300+ `ZCODE_` 前缀字面量是**非环境变量**
（IPC channel、错误码、编译期 define、协议标识）——任何「按前缀批量剔除」的规则不得误伤
它们（它们也不进白名单）。

## 注入面总账

### 归类一：发布注入合法（release.yml 唯一事实源，4 变量）

| 变量                                | 注入位置                | 消费点                                                                                                                                                                                                       |
| ----------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ZCODE_DIST_BASE_URL`               | release.yml:231         | `scripts/build-zcode.mjs:29`                                                                                                                                                                                 |
| `ZCODE_ENV`                         | release.yml:343         | `scripts/builtin-provider-config.mjs:44,61`；`packages/desktop/electron-builder.config.js:85`；`packages/desktop/vite.config.ts:152`；`packages/web/vite.config.ts:34`；`packages/desktop/tsup.config.ts:64` |
| `ZCODE_APP_VERSION`                 | release.yml:345,440,445 | `scripts/prepare-prebuilds.mjs:48`；`packages/desktop/scripts/build-metadata.mjs:103`；`apps/zcode-cli/packages/bootstrap/src/model-config.ts:72`                                                            |
| `ZCODIUM_REMOTE_ASSET_CDN_BASE_URL` | release.yml:348         | ⚠ 无消费者（死注入，见已知问题 F1）                                                                                                                                                                          |

### 归类二：宿主注入污染面（须剔除，按后果分组）

**R1 凭据/鉴权语义**（注入即接管鉴权或改道流量）

| 消费点                                                                                | 变量                                                                         | 后果                                                 |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------- |
| `packages/server/src/entry-http.ts:20`                                                | `ZCODE_SERVER_AUTH_TOKEN`                                                    | 服务端鉴权令牌被顶替                                 |
| `packages/server/src/entry-http.ts:18`                                                | `ZCODE_SERVER_HOST`                                                          | 绑定地址被顶替 → server 暴露局域网                   |
| `apps/zcode-cli/packages/adapters/src/network/http-config.ts:81`                      | `ZCODE_HTTP_PROXY`                                                           | 模型 API 出口代理被顶替（不在 denylist）             |
| `apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts:288`                 | `ZCODE_DATA_BASE_DIR`                                                        | 凭据库根目录被顶替                                   |
| `apps/zcode-cli/packages/cli/src/provider-runtime-env.ts:59-60`                       | `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` / `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` | 内置/个人 provider 配置（含 API key 文件）路径被顶替 |
| `packages/zcode-server-cli/src/server-core/core.ts:28`                                | `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`                                         | server 侧同 R1.6（mint F1 同款面）                   |
| `packages/desktop/src/main/desktopProviderConfigPaths.ts:18`                          | 同上                                                                         | desktop 侧同 R1.6                                    |
| `apps/zcode-cli/packages/bootstrap/src/auth-login.ts:345`                             | `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`                                        | 用户 API key 文件路径被顶替                          |
| `apps/zcode-cli/packages/bootstrap/src/app/standalone-account-provider-runtime.ts:51` | `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`                                         | 流量改道                                             |

**R2 路径语义**（数据落盘位置被顶替）

| 消费点                                                       | 变量                                                                                    | 后果                                                    |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `packages/desktop/src/main/desktopRuntimeEnv.ts:76,81,70,62` | `ZCODE_DESKTOP_USER_DATA_DIR` / `_SESSION_DATA_DIR` / `_HOME_DIR` / `_APPLICATION_NAME` | 登录态·会话数据写入宿主目录；应用名单实例锁错配         |
| `packages/desktop/src/main/desktopRuntimeEnv.ts:495-505`     | `ZCODE_CUA_BUNDLED_HELPER_APP_PATH` / `ZCODE_HOME`                                      | 已签名应用加载未签名 Helper（dev 路径无 packaged 保护） |
| `packages/desktop/src/main/remoteCdn.ts:47`                  | `ZCODE_CDN_BASE_URL`                                                                    | 插件市场从攻击者源拉取                                  |
| `packages/desktop/src/main/desktopRuntimeEnv.ts:234`         | `ZCODE_REMOTE_ASSET_CDN_BASE_URL`                                                       | 远程运行时（WSL/SSH）从攻击者源下载执行                 |

**R3 网络/端点语义**

| 消费点                                                   | 变量                                        | 后果                                                                 |
| -------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------- |
| `packages/desktop/src/main/desktopRuntimeEnv.ts:253-254` | `ZCODE_BASE_URL` / `ZCODE_ENDPOINT_ORIGIN`  | 权威端点 origin 被顶替（`process.env` 优先于 `.env`）→ 全部 API 改道 |
| `packages/desktop/src/main/index.ts:193`                 | `ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT` | 固定远程调试端口被顶替 → DevTools 端口本地 RCE 面                    |

**R4 计费/权益语义**

| 消费点                                                                                                                                                           | 变量                  | 后果                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------- |
| `packages/services/src/session/offPeakMockGateway.ts:68,79,512-513`；`offPeakRuntimeModel.ts:143-144`；`bigmodelCodingPlanSubscriptionProvider.ts:223,1338,1343` | `ZCODE_OFFPEAK_MOCK*` | Mock 计费网关被顶替 → 真实套餐判定被 mock 覆盖 |

**R5 可执行文件/参数语义**（最高危）

| 消费点                                                                      | 变量                                                 | 后果                                              |
| --------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------- |
| `packages/services/src/zcode-agent/zcodeAgentProcessManager.ts:441,446,447` | `ZCODE_AGENT_SERVER_COMMAND` / `_ARGS_JSON` / `_CWD` | agent 可执行文件与参数被顶替 → 直接执行任意二进制 |
| `packages/desktop/src/main/desktopRuntimeEnv.ts:478`                        | `ZCODE_LARK_CLI_BINARY`                              | lark-cli 二进制路径被顶替                         |

**R6 功能开关语义**

| 消费点                                                                                                    | 变量                                      | 后果                                          |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------- |
| `packages/services/src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.ts:251`            | `ZCODE_DYNAMIC_WORKFLOW_MODE`             | 灰度开关被顶替（agent 侧裸消费）              |
| `packages/services/src/fs/fsFaultInjection.ts:313`                                                        | `ZCODE_E2E_FS_FAULTS_ALLOW` / `ZCODE_ENV` | 门控变量本身被顶替 → 生产环境打开 FS 故障注入 |
| `packages/shared/src/runtimeEnv.ts:124`；`adapters/src/logging/index.ts:231`；`model/runner-debug.ts:465` | `ZCODE_RUNTIME_ENV`                       | 运行模式被顶替 → 触发仅 dev 生效的分支        |

**R7 前缀扫描扩大面**

| 消费点                                                                                                                                                                                                                                                                                           | 扫描                        | 后果                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- | ------------------------------------------------------------------------- |
| `apps/zcode-cli/packages/adapters/src/plugins/mcp.ts:430`                                                                                                                                                                                                                                        | `name.startsWith("ZCODE_")` | plugin manifest 任意 `ZCODE_*` 模板变量从 env 取值 → 跨出 plugin 声明边界 |
| `packages/services/src/node.ts:1039,1042`；`packages/desktop/src/host/storagePreparationProcesses.ts:132`；`packages/services/src/openviking/mcpProxy.ts:57`；`packages/services/src/system/sshConfigAlias.ts:507`；`packages/services/src/cua-permission-broker/windowsCuaDevHelperHost.ts:321` | 整包 `process.env` 传递     | 全部宿主 `ZCODE_*` 进入子进程 env                                         |

**R8 构建期烤入产物**（宿主注入 → 污染出厂件）

| 消费点                                                                                    | 变量                                                                               | 后果                                                                      |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `packages/desktop/vite.config.ts:145,161-164,195`；`packages/web/vite.config.ts:30,85`    | `ZCODE_BASE_URL` / `ZCODE_ENDPOINT_ORIGIN`                                         | 端点 origin 烤进 `__ZCODE_ENDPOINT_ENV__` → 出厂包全部 API 指向攻击者端点 |
| `packages/desktop/tsup.config.ts:64`；`packages/desktop/electron-builder.config.js:84-85` | `ZCODE_ENV` + 整包 `process.env`                                                   | 产品身份（Preview/正式）判定被顶替                                        |
| `packages/desktop/scripts/bundle.mjs:144,155`；`scripts/prepare-prebuilds.mjs:77`         | `ZCODE_ELECTRON_RUNTIME_MIRROR` / `ZCODE_DEPS_BASE_URL` / `ZCODE_NODE_DIST_MIRROR` | **构建期二进制下载源被顶替 → 供应链投毒**                                 |

### 归类三：dev 调试通道（显式开发者配置，须保留）

`.env` 文件通道（`scripts/load-endpoint-env.mjs`、`packages/desktop/src/main/desktopRuntimeEnv.ts:158-203`、`apps/zcode-cli/packages/cli/src/env.ts:75-109`）与启动脚本显式变量：

```
ZCODE_ENV（test/production）        ZCODE_DATA_BASE_DIR / YAZCODE_DATA_BASE_DIR
ZCODE_DESKTOP_APPLICATION_NAME      ZCODE_DESKTOP_HOME_DIR
ZCODE_DESKTOP_USER_DATA_DIR         ZCODE_DESKTOP_SESSION_DATA_DIR
ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA
ZCODE_DESKTOP_AGENT_BYTECODE        ZCODE_DESKTOP_AGENT_BUILD_MODE
ZCODE_BOOTSTRAP_WITH_REMOTE         ZCODE_CUA_DEV_MODE
ZCODE_CUA_PRODUCT_HELPER            ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL
ZCODE_E2E_COVERAGE                  ZCODE_E2E_ARTIFACT_DIR
ZCODE_E2E_RUN_ID                    ZCODE_E2E_RUNTIME_LOG_DIR
ZCODE_E2E_KEEP_BUILD_CACHE          ZCODE_E2E_ASK_USER_QUESTION_CLOCK_SCALE
ZCODE_E2E_FS_FAULTS                 ZCODE_E2E_FS_FAULTS_ALLOW
ZCODE_SKIP_PREPARE / ZCODE_SKIP_BUILD
ZCODE_TARGET_OS / ZCODE_TARGET_ARCH
ZCODE_DESKTOP_DIST_DIR              ZCODE_ELECTRON_RUNTIME_MIRROR
ZCODE_DEPS_BASE_URL                 ZCODE_NODE_DIST_MIRROR
ZCODE_ENABLE_MAC_SIGN               ZCODE_CUA_HELPER_BUILD_ID
ZCODE_DEBUG                         ZCODE_PREVIEW_IDENTITY
ZCODE_CDN_BASE_URL                  ZCODE_REMOTE_ASSET_CDN_BASE_URL
YAZCODE_REMOTE_ASSET_CDN_BASE_URL
```

### 归类四：非环境变量（须排除出注入面，不得误伤）

`ZCODE_` 前缀字面量中约 300 个是 IPC channel、错误码、编译期 define、协议标识、插件标识
（`packages/shared/src/channels.ts`、`errors.ts`、`model-selection-types.ts`、
`zcode-protocol/index.ts`、`mcp.ts`、`env.ts` 的 `__ZCODE_*__` define 等）。它们既不是
环境变量、也不进白名单；前缀批量规则只作用于**环境变量键**。

### 归类五：现有防护现状（收敛前）

| 位置                                                                   | 形态             | 覆盖                       | 缺口                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------- | ---------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/runtimeEnv.ts:44-94` `SANITIZED_RUNTIME_ENV_KEYS` | denylist 40 键   | 凭据/遥测族                | `ZCODE_HTTP_PROXY`/`ZCODE_NO_PROXY`/`ZCODE_AGENT_CA_CERT`/`ZCODE_BUILTIN_PROVIDER_*`/`ZCODE_DATA_BASE_DIR`/`ZCODE_BASE_URL`/`ZCODE_OFFPEAK_MOCK*`/`ZCODE_AGENT_SERVER_*`/`ZCODE_DESKTOP_*`/`ZCODE_SERVER_*` 全不在名单 |
| `apps/zcode-cli/packages/cli/src/env.ts:29-49`                         | denylist         | 同上                       | 同上                                                                                                                                                                                                                   |
| `apps/zcode-cli/packages/cli/scripts/build.mjs:244-248`                | 前缀 `ZCODE_`    | 全部 `ZCODE_` 键           | 漏 `YAZCODE_`/`ZCODIUM_`；CI 下完全不洗                                                                                                                                                                                |
| `scripts/build-zcode.mjs:22-26`                                        | 前缀 `ZCODE_`    | 同上                       | 同上                                                                                                                                                                                                                   |
| `packages/desktop/scripts/build-metadata.mjs:92-96`                    | 前缀 `ZCODE_`    | 同上                       | 同上                                                                                                                                                                                                                   |
| `scripts/build-desktop-agent-cli.mjs:18-35`                            | 双前缀点名       | `*_BUILTIN_PROVIDER*` 家族 | 仅该家族                                                                                                                                                                                                               |
| `scripts/builtin-provider-config.mjs:29-37`（R2）                      | 双前缀点名       | 同上                       | 仅该家族                                                                                                                                                                                                               |
| `scripts/dev-desktop-env.mjs:29-30`                                    | 点名 2 键        | builtin provider 旧名      | 漏改名新名 `YAZCODE_BUILTIN_PROVIDER_*`                                                                                                                                                                                |
| `packages/desktop/electron-builder.config.js:74-82`（R1）              | 外层双前缀 strip | 同上                       | 与 R2 重复                                                                                                                                                                                                             |

**结论**：全仓**没有任何一处**覆盖 `YAZCODE_`/`ZCODIUM_` 全前缀；四处防护语义各不相同
（denylist / `ZCODE_` 前缀 / 双前缀点名 / 点名 2 键），是「反复」的直接原因。

## 契约

### 1. 统一洗涤原语（deny-by-default）

单一实现，node 形态与 electron-free 纯函数形态共用同一份白名单事实源
（`packages/shared/src/hostEnvBoundary.ts` 为纯函数事实源，scripts 侧经 tsx 引用同一实现，
不复制语义）：

1. **默认拒绝**：凡键以 `ZCODE_` / `YAZCODE_` / `ZCODIUM_` 开头（宿主注入的三条命名
   前缀，覆盖旧名、新名与官方 legacy 名）**一律剔除**，白名单除外。
2. **白名单唯一事实源**：
   - 发布注入集（`PUBLISH_INJECTION_ENV_ALLOWLIST`）：release.yml 实际注入的 4 个变量；
   - dev 调试通道集（`DEV_CHANNEL_ENV_ALLOWLIST`）：归类三全量；
   - 合并口径 = 两集合并集；**白名单之外的 `ZCODE_*` 一律剔除**。
3. **非前缀键不受影响**：`PATH`/`HOME`/`NODE_OPTIONS` 等与注入面无关的键不动。
4. **白名单键的新旧名都保留**：改名表内的变量（`YAZCODE_` 新名 + `ZCODE_` 旧名）均在
   白名单（如 `YAZCODE_DATA_BASE_DIR` 与 `ZCODE_DATA_BASE_DIR` 同时保留）。
5. **收敛**：现有四处分散洗涤（CLI build.mjs、build-zcode.mjs、build-metadata.mjs、
   dev-desktop-env.mjs）与 R1 的 `stripHostInjectedBuiltinProviderEnv`、R2 内嵌逻辑
   **全部改为调用统一原语**；旧函数删除或降级为薄包装，不留第二套语义。

### 2. 为什么 deny-by-default 是安全的

- **发布链注入集封闭**：CI 只注入 release.yml 的 4 个变量（唯一白名单事实源），其余
  `ZCODE_*` 在 CI 环境本就不应存在——剔除无副作用；
- **宿主注入集与白名单不相交**：宿主 zcode 注入的变量（`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`、
  `ZCODE_DATA_BASE_DIR`、`ZCODE_AGENT_SERVER_COMMAND` 等）均不在白名单，剔除即生效；
- **点名式防护必然漏**：已实证四处防护语义不一致且各有缺口（`YAZCODE_`/`ZCODIUM_` 全漏），
  deny-by-default 把「漏」从结构性降为「白名单漏登」——白名单是有限、可评审、可 diff 的
  封闭集合。

### 3. 运行时早期剥离

- 桌面 main **打包态最早可用点**（`index.ts` 首部 import，早于任何 spawn/消费——
  ESM import 求值顺序保证它先于其它副作用执行）一次性剔除非白名单注入变量：
  后续全部 spawn/消费继承已洗涤环境。打包态才剥离（dev 态的显式调试配置由 dev
  启动器自行处理，且 dev 启动器是唯一可显式开启「仅 dev 可信族」的可信上下文）。
- R2 的 initMessage 传递链已覆盖 agent 子进程；本批确认**无旁路 spawn 点**：所有
  `env: {...process.env}` 的 spawn 点（归类二 R7）在 main 早期剥离后自动获得已洗涤环境。
- 运行时消费点若确需某注入变量，必须走「白名单 + 本 spec 登记」，不允许裸读
  `process.env`。

### 4. 门禁固化

- 新测试套件「宿主注入回归」（`packages/shared/test/hostEnvInjection.test.ts` +
  `scripts/test/host-env-boundary.test.mjs`）：
  - 以污染 env 全量注入（含历轮出过事的全部变量形态：`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`、
    `ZCODE_YAZCODE_` 新旧名、`ZCODIUM_` legacy 名、`ZCODE_AGENT_SERVER_COMMAND`、
    `ZCODE_HTTP_PROXY`、`ZCODE_OFFPEAK_MOCK` 等）断言：
    ① 构建入口函数输出与洁净环境一致；
    ② 运行时纯函数（`desktopProviderConfigPaths` 等）打包态行为不变；
    ③ 白名单变量（发布注入集 + dev 通道集）存活；
    ④ 非 `ZCODE_` 前缀键不受影响。
  - 挂进 `pnpm verify:pre-push`（经 `test:packages` / `test:scripts` 既有接线，无需新增
    脚本入口）。
- 污染环境构建冒烟 job（可选）：CI 成本高则不接线，改为文档化本地验证步骤
  （`pnpm bundle:desktop -- --os linux --arch x64` 在宿主会话内执行即等价验证）。

## 验收场景

1. **原语单测**：污染 env 输入 → 输出只剩白名单 + 非前缀键；发布注入集 4 变量存活；
   dev 通道集存活；`ZCODE_`/`YAZCODE_`/`ZCODIUM_` 三前缀全剔除。
2. **构建入口一致**：同一构建入口在「污染 env」与「洁净 env」下产出**相同**事实源
   （`loadBuiltinProviderConfig` 的 `sourcePath` 与内容一致）。
3. **运行时不变**：打包态 `desktopProviderConfigPaths` 在污染 env 下仍返回包内路径
   （R2 语义不回退）；dev 态显式 env 通道仍生效。
4. **既有防护不回退**：R1/R2 全部既有测试保留且通过（`electronBuilderConfigBuiltinSource`、
   `electronBuilderDmgLayout`、`desktopProviderConfig`、`userscriptUrlInstall` 等）。
5. **无旁路裸消费**：总账表逐点标注去向（白名单 / 剔除 / 显式通道），grep 复跑无非环境
   变量前缀误伤、无遗留分散洗涤实现。

## 总账去向标注（验收标准「逐点标注去向」的落点）

盘点出的 61 处环境消费点，其去向逐类判定如下——**白名单外的前缀键一律被原语剔除**
（这是 deny-by-default 的关键：不需要逐点改代码，剔除发生在进程环境层），
因此「去向」指的是该消费点在**剥离之后**从哪取到值：

| 消费点族群                                                                                                                                                                                 | 剥离后的取值来源                                                              | 备注                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------- |
| 桌面 main 自身注入写侧（`desktopRuntimeEnv.ts` 显式写入的 ZCODE_RUNTIME_ENV / ZCODE_ENV / ZCODE_APP_VERSION / 数据根双写 / 托盘安装目录 / CUA helper 路径 / lark 二进制 / 动态工作流模式） | **Main 决策**（剥离后由 main 显式写回，不依赖继承环境）                       | 写侧不受剥离影响                                     |
| host → agent spawn env（`services/node.ts` resolveSpawnEnv：代理/CA、官方服务开关、endpoint origin、CUA broker）                                                                           | **显式构造**（`agentProxyEnv.ts` / `officialPlatformPolicy.ts` 逐键写入）     | 写侧不受剥离影响                                     |
| 打包态 builtin 配置路径（`desktopProviderConfigPaths.ts`）                                                                                                                                 | **包内路径**（R2 语义，打包态忽略 env）                                       | 不变                                                 |
| CLI 侧 builtin/personal 配置路径（`provider-runtime-env.ts`、`standalone-account-provider-runtime.ts`、`auth-login.ts`）                                                                   | **host 注入的显式 env**（host 侧已按 R2 修正为包内路径，随 initMessage 传递） | 不变                                                 |
| 构建期事实源（`builtin-provider-config.mjs`）                                                                                                                                              | **仓库 config/provider/zcode-builtin.json**                                   | R2 + 本批原语双重保证                                |
| 构建期版本/环境（`build-metadata.mjs`、`prepare-prebuilds.mjs`、`build-zcode.mjs`）                                                                                                        | **CI 注入（发布注入集）或 .env 文件**                                         | 本批：本地构建不信任同名 shell 注入                  |
| dev 隔离目录族（`ZCODE_DESKTOP_*`、`ZCODE_DATA_BASE_DIR`）                                                                                                                                 | **dev 启动器显式注入**（dev-desktop-env.mjs 白名单开启）                      | 打包态剔除                                           |
| 构建期开关/镜像（`ZCODE_TARGET_*`、`ZCODE_SKIP_*`、`ZCODE_*_MIRROR`、`ZCODE_DEPS_BASE_URL`）                                                                                               | **构建脚本显式传参**（dev 通道集）                                            | 始终可信                                             |
| server 侧（`entry-http.ts` 的 host/port/token/static-root、`zcode-server-cli` 的 builtin 路径）                                                                                            | **启动方显式配置**（CLI 参数/环境由 server 进程自身 owner 决定）              | 打包态启动的 desktop 不经此面                        |
| 测试侧                                                                                                                                                                                     | **测试自身写入或注入对象**                                                    | 盘点确认：无一处依赖「宿主环境恰好存在某 ZCODE\_\*」 |

**关键结论**：剥离发生在**环境层**而非逐点改代码——所有消费点在剥离后自动获得
「白名单外的注入值不可见」保证；写侧（main/host 显式构造）不受影响。这正是
deny-by-default 相对「点名式防护」的结构性优势。

## 已知问题（盘点中发现的既有缺陷，本批不修，登记）

- **F1**：`ZCODIUM_REMOTE_ASSET_CDN_BASE_URL` 是死注入——release.yml 注入它，但两处消费点
  都读 `YAZCODE_`/`ZCODE_` 前缀，导致安装版自有发布源未生效。修法二选一（改注入名或改
  消费端），属独立小修。
- **F2**：三处前缀级洗涤只覆盖 `ZCODE_`（漏 `YAZCODE_`/`ZCODIUM_`）——本批统一原语后
  消解。
- **F3**：`dev-desktop-env.mjs` 点名删除漏改名新名——本批统一原语后消解。
- **F4**：`packages/desktop/scripts/prepare-prebuilds.mjs` 路径不存在（实际在仓库根
  `scripts/`）——文档路径勘误。
- **F5/F6**：`stage-agent-bundle.mjs` 与 `sea-provider-config-assets.mjs` 无实际环境消费，
  不进入注入面。
- **F7**：`electron-builder.config.js` 与 desktop/web 的 `vite.config.ts`、`tsup.config.ts`
  无前缀洗涤且把结果烤进产物——本批统一原语后由原语在构建入口统一兜住（烤入产物的
  `ZCODE_BASE_URL` 等仍需白名单显式登记，见验收场景 3 的 dev 通道集）。
