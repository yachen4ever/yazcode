# Spec：移除智谱套餐体系，所有 Provider 拉平为普通预设

## 背景

ZCodium 是去智谱化的社区 fork，但剥离不彻底：模型设置仍保留「智谱」专区
（BigModel / Start Plan / Coding Plan）、首启强制弹套餐/API Key 引导、账号子系统
（zhipu-account access + 8 个 account:* 内置 Provider）仍在数据源中。
本 PR 完成剥离：智谱（Z.ai / BigModel）降级为与 DeepSeek / Kimi 同类的普通 API-Key
预设，移除订阅（Coding Plan）的产品面。

## 产品行为

1. 模型设置导航不再有「智谱 / 自定义供应商」两个分区，所有 Provider 平铺；
   「添加供应商」模板列表不再出现 Coding Plan 条目，Z.ai API / BigModel API 与
   DeepSeek 等并列。
2. Start Plan（订阅）相关条目、连接方式选择、套餐状态卡全部不再出现。
3. 首次启动不再弹出 API Key / 套餐引导屏；无 Provider 时应用直接可用，
   用户从模型设置自行添加。
4. 自定义 Provider 的「检测可用模型」等既有功能不受影响。

## 数据层（唯一事实源）

`config/provider/zcode-builtin.json`（revision 30 → 31）：

- 删除 8 条 `account:*` providerRules（zai-family / bigmodel-family 的全部实体，
  access=zhipu-account）；
- 删除 `zai-api`（Z.ai Coding Plan）与 `bigmodel-api`（BigModel Coding Plan）两条
  套餐模板（access=zhipu-coding-plan-api-key）；
- 删除上述条目对应的孤儿 modelConfigRules；
- 保留 `zai-standard-api`（Z.ai API）与 `bigmodel-standard-api`（BigModel API）
  —— api-key 预设，与 DeepSeek 同类。

## UI 层

- `constants.ts`：清空 model provider family specs（`resolveModelProviderFamilySpecByProviderId`
  恒返回 null），family 分支（连接方式 / 套餐卡 / entitlements）在数据与 spec 双重缺失下
  不可达；相关组件代码本轮保留为 dormant，后续单独清理。
- 首启：Root.tsx 不再渲染 WelcomeScreen，`shouldEnableProviderAvailabilityLoginEntryGuard`
  返回 false（无账号体系后启动门禁失去前提）；WelcomeScreen/LoginApiKeyForm 文件
  保留 dormant。
- 导航分区按数据自然塌缩：family Provider 不存在，「智谱」分区标题不再渲染。

## 明确不做（本轮范围外）

- 物理删除 account-provider / coding-plan / OAuth / off-peak 子系统代码（跨
  services/CLI/desktop 上百文件，单独 PR）；
- 历史用户 `providerFamilyDomain` 等 settings 字段清理（无消费者后无害）。

## 验收场景

1. 全新数据目录启动：无首启套餐屏，直接进入工作区。
2. 模型设置：左侧无「智谱」分区与 Start Plan；「添加供应商」列表中 Z.ai API /
   BigModel API 与 DeepSeek 并列，无 Coding Plan 条目。
3. 选择 Z.ai API 预设 + API Key + 添加模型（可用检测）→ 可执行、可对话。
4. 旧数据目录（曾有 account provider 残留配置）启动不崩溃：残留规则被
   builtin revision 对齐逻辑清除或不再渲染。
