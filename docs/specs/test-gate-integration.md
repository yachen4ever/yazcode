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

## 行为规则

1. **门禁从根 workspace 触发**。根 `test` 脚本用 `pnpm --filter` 调用各包已有脚本；
   任何 `pnpm --dir apps/zcode-cli/...` 形态的调用都不可靠。
2. **各包 test 脚本的 glob 必须真实命中**。`tsx --test test/**/*.test.ts` 在
   bash/zsh 下依赖 glob 展开，`**` 不递归时只会匹配一层；脚本必须能在实际 shell 下
   命中全部测试文件。
3. **跨平台路径断言不得硬编码 Windows 路径**。路径测试用 `node:path` 的
   `resolve`/`join` 构造当前平台的绝对路径，不写死盘符。
4. **CLI 顶层测试（`apps/zcode-cli/tests/*.test.mjs`）需要 tsx loader**。它们 import
   `packages/shared/src/**` 的 `.ts` 源文件，必须以 `node --import tsx --test` 运行，
   否则 `.js` 扩展名解析不到编译产物而报 `ERR_MODULE_NOT_FOUND`。
5. **测试失败即门禁失败**，不得跳过、不得标注「已知失败」后放行。

## 状态所有者

| 事实 | 所有者 |
| --- | --- |
| 门禁组成与执行入口 | 根 `package.json` 的 `test` / `verify:pre-push` |
| 各包测试脚本与 glob | 各包 `package.json` |
| CI 中测试的触发 | `.github/workflows/tests.yml` |
| 路径构造的平台无关写法 | 各测试文件自身 |

## 明确不做

- 不引入新的测试框架（沿用 `node:test` + `tsx`）。
- 不为「让测试通过」而修改生产代码。测试暴露的实现缺陷按缺陷处理，走各自的 spec。
- 不在本次把 `packages/desktop` 等包的 `test` 目录结构统一（超出范围）。

## 验收场景

1. **从根跑通**：根 `pnpm test` 一次执行完所有有测试的包，全绿。
2. **从嵌套 workspace 跑会失败**（反证不变式 1）：`cd apps/zcode-cli && pnpm --filter
   @zcode/core test` 报 `tsx: command not found`——这是已知的上下文限制，**门禁不得
   以此形态调用**。
3. **路径测试跨平台**：`packages/shared` 的 `genUiPaths` 测试在 Windows 与 POSIX 上
   都通过，不因盘符差异失败。
4. **CLI 顶层测试可达**：`apps/zcode-cli/tests/*.test.mjs` 的 9 个用例被执行并通过。
5. **门禁拦截回归**：任一包测试失败时，`verify:pre-push` 退出码非 0。
6. **CI 覆盖**：`tests.yml` 在 push 到 main 与 PR 时运行，与本地门禁同源同口径。
