# 验收记录：yazcode 26.2.1

按 `docs/specs/release-acceptance-order.md` 的约定记录：**实机验收先于正式发布**。本记录
对应 v26.2.1 的 draft release 转正式发布前的验收。

## 交付物与来源

| 项 | 值 |
| --- | --- |
| 版本 | 26.2.1（`package.json`） |
| tag | `v26.2.1` → `b8d023b1ba98e0749058a1ec3f9ad80685851a31` |
| CI run | `39504364525`（release.yml，`keep_draft=true` → publish job skipped） |
| 验收机 | workwin（192.168.5.13，Windows 10 LTSC 2021） |
| 安装包 | `yazcode-26.2.1-win-x64.exe`，154,201,500 字节 |
| sha256 | `bc930143f9906caea6b3e08d13ef6dfa6874c7320237b751abf25a10e23a69e3` |
| 校验 | 与 CI 发布资产 `sha256.txt` 一致；workwin 落盘后重算亦一致 |
| 安装方式 | NSIS 静默 `/S`，安装前退出运行中的 yazcode（14 个进程） |
| 安装后版本 | 26.2.1.0（`yazcode.exe` ProductVersion） |

## 提交构成

| Commit | 内容 |
| --- | --- |
| `cfc0554` | 同步 vendor/openviking 到上游 v0.5.1.1（11 文件）+ `INTEGRATION_VERSION` 0.5.14 → 0.5.21 + 许可台账基线更新 |
| `373fb50` | 补齐 CHANGELOG 26.1.2 ~ 26.2.0 四个版本条目；新增发版顺序 spec |
| `b8d023b` | 版本号 bump 26.2.0 → 26.2.1 |

## 验收结论

| # | 验收项 | 结论 | 证据 |
| --- | --- | --- | --- |
| ① | 新会话作图可内联渲染且高度自适应 | **通过** | 端到端：CLI 以 desktop surface 运行时 agent 产出 `e2e-verify-20261021.html`（888 字节）并输出 `::visualize{"path":"..."}` 引用；协议侧返回 5327 字节并注入 `zcode-gen-ui-height-bridge` 测高桥 |
| ② | visualize 技能仅在桌面会话可见 | **通过** | 设 `ZCODE_GEN_UI_OUTPUT_ROOT`（desktop surface 条件）时技能清单含 visualize（52 项）；不设时仅 9 项且无 visualize。桌面端市场缓存已 seed `zcode-plugins-official\visualize\0.1.0`（含 vendored d3-7.9.0） |
| ③ | 代码块内 `::visualize` 引用不渲染 | **通过**（代码级） | 解析器 `projectGenUiReferences` 复用 `findMarkdownCodeRanges` 做代码区排除，代码区内的引用直接跳过；另有流式未完成态门槛 |
| ④ | 历史消息重放仍可渲染 | **通过** | 历史会话 `sess_6ad8297`（00:43:28）的引用指向 `visualizations\b63913f0…\week-calendar-2026-10-12-18.html`，该文件在 workwin 上存在（3321 字节）且在输出根内，协议读取返回 200 / 5327 字节 |
| ⑤ | CLI 直跑不注入目录行 | **通过** | CLI 直跑（不带 surface env）时 agent 明确回答"没有注入可视化输出目录"；带 `ZCODE_GEN_UI_OUTPUT_ROOT` 时正确注入该路径 |
| ⑥ | 内置 OpenViking 集成升级到 0.5.21 | **通过** | 安装后 `resources\openviking\zcode\plugin.json` 与 `hosts\zcode\openviking.integration.json` 均为 `0.5.21`（升级前 0.5.14）；四项新能力全部到位：`OPENVIKING_EXTRA_HEADERS`、tool 载荷脱敏替换、`recallExcludeUris` 透传、CRLF 兼容 |
| ⑦ | 主进程安全边界生效 | **通过** | 四条路径经 CDP 调 `gen-ui://local/file` 实测：根内合法路径 → 200 / 5327 字节 / 注入测高桥；根外路径、非 html 文件、`..` 穿越路径 → 一律返回错误态"可视化源文件不可用" |

### 附加核验

- **scope 目录派生精确匹配**：桌面会话 `sess_6ad8297b-329d-42bf-a0dd-6445ecd760aa` +
  workspace `D:\code\newapi` 的 `sha256(JSON.stringify([workspace, sessionId]))` =
  `b63913f0b461457d70d8270c99a32c9fc0b3fab3b27d76e5b2ae9164747589e0`，与输出目录下的
  实际子目录名完全一致。
- **协议注册**：renderer 启动参数含 `--standard-schemes=zcode-media,gen-ui
  --secure-schemes=gen-ui`，gen-ui 已注册为 privileged scheme。
- **agent surface**：桌面端 agent 进程命令行为 `zcode.cjs app-server --stdio --surface desktop`。
- **服务端**：debsvc OpenViking 已升级至 0.5.1.1（升级前备份
  `/srv/backups/ov/openviking-pre-0.5.1.1-20261021-053646.tar.gz`，回滚需"二进制 + 备份"同时回）。
- **门禁**：`pnpm verify:pre-push` 退出码 0（lint 0 error、architecture violations 0、
  skill-residue 0、typecheck:cli 15 个子包通过）。

## 遗留与说明

1. **26.2.0 的验收记录缺失**：查 10-18 / 10-19 的 yazcode 日志，`gen-ui` / `visualize`
   关键字命中数为 0，仅在会话库里留下引用文本。这说明 26.2.0 的验收从未闭环——本记录
   是该功能链的**首次完整验收记录**。这也是 `docs/specs/release-acceptance-order.md`
   的直接由来。
2. **验收项 ③ 属代码级核验**：代码区排除由解析器单测（`packages/ui/test/genUiReferences.test.ts`）
   覆盖，本次实跑 35 个用例全通过（含 `leaves quoted code inert and suppresses partial
   stream markers`），但未构造"真实代码块 + 真实渲染"的端到端场景，结论基于实现与单测。
3. **越界路径的历史引用**：历史会话中 `D:\code\newapi\outside-test.html` 等引用指向
   workwin 上不存在的文件（属 r9000x 产生的路径）。这不影响结论——它们本就该走错误态，
   实测行为与 spec 一致。

## 本次验收发现的技术债（未修，已记录待决）

1. **`packages/ui` 缺 test 脚本**：该包有 3 个测试文件（`genUiReferences.test.ts`、
   `nonCliAcpRetirement.test.ts`、`speedLabels.test.ts`），但 `package.json` 没有 `test`
   脚本，导致这些测试**从未被任何命令执行过**——`node --test` 直接跑会因 `.js` 扩展名
   解析不到编译产物而失败，须用 `tsx --test`。本次已补 `test` 脚本（48 个用例通过），
   与 `packages/shared` / `packages/services` / `packages/desktop` 的既有约定一致。
2. **全仓测试未接入任何门禁**：`verify:pre-push` = lint + 架构检查 + 技能残留 +
   CLI 类型检查，**不含测试**；`.github/workflows/*.yml` 里也没有任何 `pnpm test`
   调用。CI 绿灯不等于测试通过。是否把各包 `test` 接入 `verify:pre-push` 属于门禁
   范围变更，需要单独决策（会显著拉长本地与 CI 时长），本次未动。

