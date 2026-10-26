# 上游引入评估：ZCodium v1.16.2 → v1.17.1（2026-10-26）

调研方式：只读 ref 比对（`git fetch` 加临时 ref + `git show`，未 merge/pull）。基线：本轮评估前已消化至 ZCodium v1.16.2（`ad118be3`）/ zai-org 3.16.2（`3c5b2276`）。

## 上游动态

- **zai-org/ZCode main 无移动**：仍为 `3c5b2276`（3.16.2，2026-10-20），无新 tag/release。无上游源码增量。
- **ZCodium 发布 v1.17.0（10-24）与 v1.17.1（10-26，Latest）**，`ad118be3..v1.17.1` 共 9 提交；另有预发布 `v1.17.1-audit.20261026`（audit 渠道，内容同）。

## 逐项评估

### 1. v1.17.0 多目录项目与工作台（`b0de1476`，#79）——已消化

多目录语义即本轮 B-P1a/P1b/P2 的参考源（附加目录白名单、namespace=basename、任务行固化、冷恢复重解析均已按本仓 spec 落地并合入 26.3.0）。其 UI 侧（ProjectEditor 等）正在 P3 实现中被读取参考。**无新增待移植项**。

### 2. v1.17.1 DMG 布局修复（`aa73b617`，#81）——本仓无此回归；契约测试值得移植

上游 2026-10 同步曾整体覆盖 `dmg.contents`（图标坐标回退默认值、解除拦截说明文件丢失），v1.17.1 恢复并新增 97 行布局契约测试。**本仓核对：`packages/desktop/electron-builder.config.js:737-773` 的 dmg 块完好**——自定义背景（620x560）、图标坐标 (150,120)/(470,120)、双说明文件 (170,365)/(450,365)、显式 size 3200m 全部在位，未受同款回归。

**候选移植（cheap）**：`electronBuilderDmgLayout.test.ts`（97 行契约测试，锁定背景/坐标/说明文件落点）——我们同款脆弱配置（未来一次上游同步即可打掉）却无守卫。列入发版工程批次随手项。

### 3. v1.17.1 预发布版本注入恢复（`88924fbc`，#83）——本仓部分已有；残余登记候选

上游修复 `ZCODE_APP_VERSION` 在构建元数据、stageCli、stageRemoteAssetsCli 三处的优先级（发布工作流注入版本 > package.json；本地开发回退）。本仓核对：

- `packages/desktop/scripts/build-metadata.mjs:89` **已具备**同款优先级（`ZCODE_APP_VERSION || rootPackageJson.version`），desktop 侧无需移植；
- `zcode-server-cli` packaging 侧（上游的 stageCli/stageRemoteAssetsCli）本仓为旧一代架构（`prepare-prebuilds.mjs` 单点，既有 backlog「迁入 zcode-server-cli 恢复单一职责」），无对应消费点——**该缺口随既有 backlog 一并处理**，不单独立项；
- 背景：26.2.3 的 bump 曾漏改 package.json（tag 内版本字段滞后），26.3.0 起已按完整先例双改。本项是「版本双源」问题的上游解法，记录备查。

### 4. v1.17.0 双架构更新清单单点汇总（`61eef508`，#76/#78）——登记候选

远程资产发布链路的清单汇总与真实资产验证。与本仓已知 backlog（`prepare-prebuilds.mjs` 700 行单点、remote-assets 架构落后一代）同域，**合并到该 backlog 评估**，不单独立项。

### 5. 其余

- audit issues：#85/#83/#81（v1.17.1 本体）、#79（多目录）均 closed；#87 为用户 SSH glibc 使用问题（非代码变更），不涉及移植。

## 判定

1. **无必须立即引入的安全/稳定性变更**；
2. **随手候选**：DMG 布局契约测试（97 行，发版工程批次顺手带上）；
3. **登记候选**：远程资产版本注入与双架构清单（随 prepare-prebuilds 迁移 backlog 一并评估）；
4. **进行中**：多目录 UI（P3）即上游 v1.17.0 UI 面的对应实现，进行时无需额外引入。

## 关联

- 上一轮评估：`docs/upstream-port-tasks-20261022.md`（T1 自测、T2 sqlite 门禁均已交付于 26.2.3/26.3.0）。
- 门禁纪律不变：上游只读（fetch+show），严禁 merge/pull。
