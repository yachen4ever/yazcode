# Spec：架构治理脚本自测（T1 P1）

任务书 `docs/upstream-port-tasks-20261022.md` T1 的 P1。上游（zai-org main@`3c5b2276`）
把治理脚本自身纳入测试（`architecture-governance-review.test.mjs`）；本仓按同一动机
自建用例，**不抄上游文件**（判定器实现不同构）。

## 动机

`pnpm architecture:check --changed` 已是 `verify:pre-push` 的一环，但判定器
（`scripts/architecture/index.mjs` + `policy.mjs`）自己没有任何测试——判错模块边界时
会错误放行或拦截真实的跨域依赖，而现有门禁发现不了这件事。2026-10-25 的
`check-vendor-openviking.mjs` 幻影漂移事故（深层路径映射 bug + 短路假绿存活两个版本）
就是"门禁脚本自身无自测"的实例。

## 契约

1. **用例针对判定语义，不针对仓库现状**：在临时工作区构造最小 `architecture-policy.yaml`
   与源文件 fixture，真跑导出的 `checkArchitecture({ cwd })` 断言违规/放行。仓库自身
   的模块增删不改变这些用例。
2. **覆盖的判定面**（每面至少一正一反）：
   - policy 校验：模块 id 重复/为空、依赖未知模块必须抛错；
   - managed 模块缺少 `module.ts` / `contract.ts` → `missing-module-artifact`；
   - 跨模块未声明依赖 → `module-dependency`；声明后放行；
   - 跨模块深层导入（非公开入口）→ `deep-import`；公开入口放行；
   - 同模块层方向（layerOrder 低层依赖高层）→ `layer-direction`；高层依赖低层放行；
   - `forbidCycles` → `cycle`（global）；无环放行；
   - `max-file-lines` 超限 → 违规；exception 路径命中放行；exception 过期 →
     `expired-exception`（global）；
   - baseline 消解：已登记 fingerprint 的违规进 `baselineViolations` 而非
     `newViolations`。
3. **红灯红线**：故意改坏判定器（如翻转层方向比较）后，本测试必须失败——用例失效
   即门禁失效。验收时注入一次并确认变红。
4. **不改变判定语义**：本 spec 只加自测，不改 `architecture-policy.yaml` 与判定器的
   既有行为；P2（上游准入快照）另立项。

## 门禁接入

`scripts/test/architecture-governance.test.mjs` 经既有 `test:scripts` glob 进入根
`pnpm test`（CI 同口径），不重复挂接。
