# 上游（ZCodium v1.16.3 / v1.17.0）变更引入评估与任务书

> 产出背景：2026-10-25 用户指令「先看下上游变更我们是否值得引入」（T1/T2 立项前的增量复核）。
> 基准：上游 `zai-org/ZCode` main@`3c5b2276`（与 2026-10-22 轮一致，**零新提交**，审计 issue 无 #63 后产出，
> 10-22 的功能面不引入结论继续覆盖全部上游主干增量）。
> 本轮增量全部来自 `ZCodium-project/ZCodium` main（`ad118be3`→`b0de1476`，3 个提交、3 个批次）。
> 取源方式照旧：`git fetch` 只读 ref + `git show`，严禁在 yazcode 目录对上游 merge/pull。

## 结论（TL;DR）

**只有一个 5 行级小笔值得引入**（ZCodium #66 的浏览器迟到上报防护，同位 bug 已在 yazcode 实证）。
v1.17.0（多目录项目）与 1.16.3（SSH 运行时链路）经逐文件比对，要么我们结构上已规避，要么属
再基线级大件。

**2026-10-25 用户拍板**：① **多目录项目（v1.17.0）决定引入**，作为下一次 y 位批次的主体单独立项
（以 ZCodium v1.17.0 为参考实现，基座差异按本仓现状重做，不做整体再基线）；② **T2（sqlite
schema 只增契约门禁）即刻开工**，#66 迟到上报防护与 T2 同批交付。T1（治理自测）随后。

## 批次逐项判定

| 批次 | 内容 | 判定 | 依据 |
| --- | --- | --- | --- |
| ZCodium 1.16.3（`01f32181`，#68/#75） | SSH 运行时下载源、离线导入、安装绑定 | **不引入（核心 bug 不存在）** | 其根因是打包器未消费自有 Release 基址、仍请求官方 CDN 的 1.x 资产；yazcode 的 `remoteCdn.ts` 从 26.0.x 起就是构建期注入 `__YAZCODE_REMOTE_ASSET_CDN_BASE_URL__` 的自建源设计，官方 CDN 仅在 marketplace 开关下可达。`sourceServerReleaseResolver` 属官方 Source Server 面，本仓已断连不涉及。剩余两块：离线导入是我们没有的功能（当前无使用场景），安装绑定修复在他们高度分叉的 `desktopRemoteSessions.ts`（对方版）里，无可直接移植面。若日后本仓 SSH 运行时链路出问题，此提交是现成参考 |
| ZCodium #76/#78（`61eef508`） | 双架构更新清单单点汇总 + 验证真实发布资产 | **不引入（结构性已规避）** | 其 bug 是 matrix 各 job 各自产出 `latest*.yml` 且未校验引用资产真实存在。yazcode `release.yml` 已刻意分名（`latest-linux.yml` 与 `latest-linux-arm64.yml` 并行上传，L317 注释）且走「全部产物上传完才 publish」的 draft 流程，客户端可见时元数据与资产同批就位。其 375 行脚本 + 821 行测试的「发布前校验元数据引用」思路可日后借鉴，非欠账 |
| ZCodium #66（`1ef5185c`，随 10-22 批次发布） | 远控/社区/浏览器/设置数据根四类实机修复 | **部分引入（1 项）** | 见下方「同位核验」；仅浏览器迟到上报一项在 yazcode 实证同病 |
| ZCodium #65（`e5f7a881`） | 退出报错、legacy 版本线、打包数据库启动 | **不引入（均未继承病根）** | ① 退出 ReferenceError 是上游 3.16.x 再基线丢失 `browserWindowId` 定义所致——本仓未再基线 3.16.x，`desktopWindowLifecycle.ts` 无该引用形态；② 打包数据库启动是他们 tsup 分包破坏 `createRequire(import.meta.url)` 所致——本仓 `taskIndexRepo.ts` 早已用 `createNodeRequire()`（L40），且 26.2.x 实机验证任务库正常；③ legacy 版本线更新属其 1.y.z 双线机制，本仓独立版本线不适用 |
| ZCodium v1.17.0（`b0de1476`，#79/#80，393 文件 +36689） | 多目录项目、工作台、fullView、GenUI 交互式、插件成功事件等 | **本轮不引入（再基线级大件，需单独拍板）** | 其实现锚定官方 3.16.2 源码再修通，属 10-22 已整体拒绝的 3.16.2 UI 批次的修复版；移植到本仓分叉基座等同一次 y 位大版本。其中若干子项对将来有参考价值：插件成功事件接线、同 cwd 草稿隔离、GenUI「确认后向原会话续写」是本仓 gen-ui P2 的现成参照；「多目录但配置信任范围不合并」（AGENTS/MCP/hooks 沿会话绑定目录链）的边界处理值得抄思路 |

## 同位核验（#66 拆解）

| #66 子项 | yazcode 同位状态 | 判定 |
| --- | --- | --- |
| `browserGuestManager.reportResidency` 迟到上报 | **同病实证**：本仓 L825 直接 `requireRendererOwnedTab(payload)`，无 closed 前置防护；tab 关闭后 renderer 在途上报会 throw 进 main 进程错误日志（ZCodium #67 同型）。修复为 5 行早退 + 测试 | **引入候选（约 0.5 天，可与 T2 同批）** |
| `paths.ts` `ZCODE_DESKTOP_HOME_DIR` dev 实例 home 一致性 | 本仓 dev 隔离走 `docs/specs/dev-data-dir-isolation.md` 的 `ZCODE_DATA_BASE_DIR` 方案 | 不引入 |
| `settingService`/`providerFamilyDomain*` 设置数据根 | 与 dev home 修复联动，且 provider family 域迁移与本仓去智谱后的 Provider 模型不同构 | 不引入 |
| `autoUpdateVersion.ts` legacy 版本线 | 本仓独立版本线 + 强更门禁恒放行 stub | 不引入 |

## 谱系提示

ZCodium v1.17.0 起已「固定官方 3.16.2 源码」再修功能——此后与本仓的 diff 对比（含 10-22 差距评估的
共同祖先 `1f5a69e3` 口径）应以 `zcodium-readonly/main@b0de1476` 为新基准，旧口径存档仅作历史参考。

## 明确不做

- ~~不做 v1.17.0 多目录项目的移植立项~~ **已改判（2026-10-25 用户拍板引入）**：纳入排期，作为
  下一次 y 位批次主体单独立项；实施时以 ZCodium v1.17.0 为参考，基座差异按本仓现状重做
  （不整体再基线 3.16.2），其「配置信任范围沿会话目录链、不因多目录合并执行」的边界处理照抄。
- 不引入 #76 的更新清单校验脚本（现发布链无此欠账）。
- 不引入 #65/#66 其余子项（见同位核验表）。
- 重申：上游主干无新增量，10-22 轮「9 项功能增量不引入 / vitest 不迁 / max-lines 不放宽 / 按需选测不引入」结论全部维持（多目录项目属用户主动拍板的例外，经本轮专项评估）。

## T1/T2 状态

`docs/upstream-port-tasks-20261022.md` 的 T1（架构治理自测 + 上游准入快照）、T2（sqlite schema
只增契约门禁）截至本文**均未实施**，仍为下一批首选。本轮评估未改变其分期建议与验收红线。
