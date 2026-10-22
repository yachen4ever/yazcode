# Spec：测试接入门禁

## 背景

仓库的测试**从未被任何自动命令执行过**。`verify:pre-push` 由 lint、架构检查、技能残留
门禁与 CLI 类型检查组成，不含测试；`.github/workflows/*.yml` 里也没有任何 `pnpm test`
调用。结果是「CI 绿灯」与「测试通过」两件事完全无关。

三个包存在 `test` 脚本但从未被触发过，原因是**从错误的 workspace 上下文调用**：

- `apps/zcode-cli` 是**嵌套的独立 pnpm workspace**（自带 `pnpm-workspace.yaml` 与
  `pnpm-lock.yaml`）。从 `apps/zcode-cli` 内部调用子包脚本时，PATH 里只有该嵌套
  workspace 的 `node_modules/.bin`，不含 `tsx`；`@zcode/core` 与 `@zcode/adapters`
  的 test 脚本因此直接 `sh: tsx: command not found`。
- **从根 workspace 调用则一切正常**：根 `package.json` 的 devDependencies 提供了 `tsx`，
  `pnpm --filter <pkg> test` 从根执行时 PATH 含根的 `node_modules/.bin`。

结论：**门禁必须从根 workspace 调用各包脚本**，不得用 `pnpm --dir apps/zcode-cli/...`。
这是本 spec 的核心不变式。

### 但「只从根调用」不是根治

根调用口径只是**绕开**了依赖缺失，没有消除它：`@zcode/core` 与 `@zcode/adapters`
的 test 脚本要跑 `tsx`，却没有在自己的 `devDependencies` 里声明 `tsx`——它们是
**借用了根 workspace 的 devDependency**。这种「隐式借用」让脚本只在根上下文成立，
一旦被嵌套上下文调用（如仓库自身的 `typecheck:cli` 就用
`pnpm --dir apps/zcode-cli/packages/<pkg> typecheck` 形态）就直接失败。

根因是**脚本依赖 PATH 上的二进制，而该二进制只在根 workspace 可见**。

### 为什么加 devDependency 不算修好

一种直觉修法是给两个包补上 `tsx` 的 `devDependencies`。实测**无效**：pnpm 不会为
嵌套 workspace 的成员建独立依赖树——`apps/zcode-cli/packages/core/node_modules` 里
连 `cheerio` 这类直接依赖都没有（全部向上解析到根 `node_modules`）。因此包级
devDependency 既不会把 `tsx` 装进该包目录，也不会把它放进嵌套上下文的 PATH，
`sh: tsx: command not found` 依旧。

### 真正的修法：用模块解析而不是 PATH 二进制

`node --import tsx --test` 与 `tsx --test` 的区别在于加载器的引入方式：
前者走 **Node 的模块解析**（从脚本所在目录逐级向上找 `node_modules/tsx`），后者走
**PATH 上的可执行文件**。模块解析在嵌套上下文同样成立（实测 15/15 用例通过），
而 PATH 不成立。

故规则是：**测试脚本一律用 `node --import tsx --test` 形式**，不裸调 `tsx` 二进制。
这与仓库既有的 `@zcode/contracts`、`apps/zcode-cli` 顶层测试写法一致。

> 与上游的差异：上游 `zai-org/ZCode` 的 CLI 子包统一用 `vitest` 作为测试运行时，
> 且 `vitest` 由各包自己的 `devDependencies` 声明（`@zcode/core`、
> `@zcode/adapters` 均含 `"vitest": "^4.1.5"`）。上游从不在脚本里裸调一个未声明的
> 二进制，因此不存在本问题——见 `docs/upstream-port-tasks-20261022.md` 的引入评估。

## 行为规则

1. **门禁从根 workspace 触发**。根 `test` 脚本用 `pnpm --filter` 调用各包已有脚本；
   这是门禁的**组织方式**（便于聚合与统一失败口径），不是脚本能否运行的前提。
2. **测试脚本以模块解析方式引入运行时，不裸调 PATH 二进制**。统一写成
   `node --import tsx --test "<glob>"`，不写 `tsx --test "<glob>"`。
   - 原因：pnpm 不为嵌套 workspace 的成员建独立依赖树（实测
     `apps/zcode-cli/packages/core/node_modules` 里连直接依赖 `cheerio` 都没有，
     全部向上解析到根 `node_modules`）。因此包级 `devDependencies` 既装不进该包目录，
     也进不了嵌套上下文的 PATH，`sh: tsx: command not found` 无法靠补声明消除。
   - `node --import tsx` 走 Node 模块解析（逐级向上找 `node_modules/tsx`），在嵌套
     与根两种上下文下都成立。
   - 适用面：全仓统一。`@zcode/core`、`@zcode/adapters`（本次修正的原始问题）；
     `@zcode/contracts` 与 `apps/zcode-cli` 顶层测试本已是该形式；
     `packages/shared`、`packages/ui`、`packages/services`、`packages/desktop`
     （这四个在根 workspace 内 PATH 可见根 `node_modules/.bin/tsx`，此前能跑，
     本次一并统一，避免同一仓库存在两套写法）。
   - `packages/zcode-cua` 用 `node --test` 跑纯 `.mjs`，不涉及 tsx 加载器，不改。
3. **测试脚本写法有护栏**。`packages/shared/test/testScriptContract.test.ts` 断言：
   任何包的 `test` 脚本不得裸调 `tsx` 二进制；用了 tsx 加载器的必须以
   `node --import tsx` 开头；glob 必须带引号。改回旧写法会让该用例变红。
3. **CLI 子包测试需要先构建其依赖包的 dist**。`@zcode/core` / `@zcode/adapters` 与 CLI
   顶层测试 import 兄弟包的**发布入口**（`@zcode/contracts` 等），其 `exports` 指向
   `dist/`，不构建则报 `ERR_MODULE_NOT_FOUND`。
   - 测试够用的最小构建集（约 16s）：`shared-types → contracts → dynamic-workflow →
     dynamic-workflow-runtime`，由 `test:build:cli` 承担，使 `pnpm test` 单独可跑。
   - `typecheck:cli` 需要更多（`adapters`、`core`、`i18n`、`bootstrap`、`tui` 等），
     实测须构建**全部** CLI 包，故 `verify:pre-push` 前置 `build:cli`（约 76s）。
   - **这是既有事实**：`typecheck:cli` 在未构建的干净检出上同样失败——门禁不是新引入
     的问题，但把它显式化后，新检出不再依赖「本机碰巧构建过」。
4. **各包 test 脚本的 glob 必须真实命中**。`tsx --test test/**/*.test.ts` 在
   bash/zsh 下依赖 glob 展开，`**` 不递归时只会匹配一层；脚本必须能在实际 shell 下
   命中全部测试文件。**正确写法是引号形式**（`"test/**/*.test.ts"`），交给 node 自己
   递归展开——实测 shell 展开漏掉深层测试文件（探针：15 例 vs 16 例）。
5. **跨平台路径断言不得硬编码 Windows 路径**。路径测试用 `node:path` 的
   `resolve`/`join` 构造当前平台的绝对路径，不写死盘符。`path.isAbsolute("C:\\...")`
   在 POSIX 上为 `false`。
6. **CLI 顶层测试（`apps/zcode-cli/tests/*.test.mjs`）需要 tsx loader**。它们 import
   `packages/shared/src/**` 的 `.ts` 源文件，必须以 `node --import tsx --test` 运行，
   否则 `.js` 扩展名解析不到编译产物而报 `ERR_MODULE_NOT_FOUND`。
7. **测试失败即门禁失败**，不得跳过、不得标注「已知失败」后放行。

## 状态所有者

| 事实 | 所有者 |
| --- | --- |
| 门禁组成与执行入口 | 根 `package.json` 的 `test` / `verify:pre-push` |
| 各包测试脚本与 glob | 各包 `package.json` |
| 测试运行时的引入方式（模块解析 vs PATH） | 各包 `package.json` 的 `test` 脚本写法 |
| CI 中测试的触发 | `.github/workflows/tests.yml` |
| 路径构造的平台无关写法 | 各测试文件自身 |

## 明确不做

- 不引入新的测试框架（沿用 `node:test` + `tsx`）。
- 不为「让测试通过」而修改生产代码。测试暴露的实现缺陷按缺陷处理，走各自的 spec。
- 不在本次把 `packages/desktop` 等包的 `test` 目录结构统一（超出范围）。

## 验收场景

1. **从根跑通**：根 `pnpm test` 一次执行完所有有测试的包，全绿。
2. **从嵌套 workspace 也能跑通**（不变式 2 的验收）：`cd apps/zcode-cli && pnpm --filter
   @zcode/core test` 不再报 `tsx: command not found`，用例正常执行（15/15 通过）；
   `@zcode/adapters` 同理（20/20 通过）。这是本次修复的核心验收项——从
   「已知上下文限制」变为「成立」。
3. **加载器引入方式统一**：全仓各包的 `test` 脚本均为 `node --import tsx --test`
   形式（`packages/zcode-cua` 的纯 `.mjs` 除外），不再有裸调 `tsx` 二进制的脚本；
   该约定由 `testScriptContract.test.ts` 守护。
4. **路径测试跨平台**：`packages/shared` 的 `genUiPaths` 测试在 Windows 与 POSIX 上
   都通过，不因盘符差异失败。
5. **CLI 顶层测试可达**：`apps/zcode-cli/tests/*.test.mjs` 的 9 个用例被执行并通过。
6. **门禁拦截回归**：任一包测试失败时，`verify:pre-push` 退出码非 0。
7. **CI 覆盖**：`tests.yml` 在 push 到 main 与 PR 时运行，与本地门禁同源同口径。
8. **CI 冷启动可跑**：CI 只装依赖、不预构建任何产物，`tests.yml` 自己先构建 CLI 包
   再跑测试——不依赖「本机碰巧构建过」。
9. **门禁在干净检出可跑**：清空全部 CLI `dist/` 后，`pnpm verify:pre-push` 退出码 0。
   门禁自带构建前置，不要求使用者先手工构建。
