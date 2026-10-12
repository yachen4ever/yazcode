# Changelog

yazcode 使用年份号段 `26.y.z`（y = 引入上游变更的批次，z = 纯内部迭代）。更早的 `1.0.x`
版本属 ZCodium 同源期（2026-10-04 ~ 10-07），历史见对应的 GitHub releases，此处不再罗列。

每个版本的完整产物与说明见 [Releases](https://github.com/yachen4ever/yazcode/releases)。

## 26.1.1 (2026-10-12)

- **视觉桥接（Vision Fallback）原生化**：主模型不支持图片输入时（not multimodal 类错误），
  自动把消息中的图片交给用户配置的 fallback 视觉模型转成文字描述并重试一次；无视觉事实
  缓存（进程 + 落盘）免后续试错；未配置时错误增强指引、桥接失败占位降级不挂死 turn。
- 模型设置：视觉桥接独立设置区（与接入端点模块平级）；fallback 选择器只列勾选了图片
  输入的模型。
- 模型设置：「自定义供应商」更名「接入端点」。

## 26.1.0 (2026-10-11)

- **引入上游 3.15.1 的官方办公插件**（Z.ai 重新以 Apache-2.0 发布）：pdf / documents /
  spreadsheets 三插件随包分发、默认启用，提供排版工作流（报告 / 创意海报 / LaTeX 简历）、
  docx-js 创建与设计系统、图表与 VBA 模板，配套 `visual-judge` 渲染质检子代理。
- MiniMax 衍生办公技能改名退居（`pdf-ops` / `docx-redline` / `xlsx-ops`），与官方插件按
  意图互补路由（造新的走插件、改旧的走 ops）；`pptx` 保留 MiniMax 版。

## 26.0.7 (2026-10-11)

- 内置 OpenViking 客户端运行时同步上游 v0.5.0（hooks 超时修复、Windows 斜杠路径匹配等）。

## 26.0.6 (2026-10-11)

- 吸收 axiom-desu 的两项修复：http.request 回调构造越界 Response 导致 agent 进程被带走；
  上游 3.15.1 白拿修复（事件驻留内存泄漏、Claude 子代理识别）。CUA 技能文本与
  @trycua/cua-driver 0.28.2 对齐。

## 26.0.5 (2026-10-10)

- 服务商级 **TLS 证书钉扎**（`tlsCaPath`）：导入自签证书（DER 自动转 PEM），按 origin
  缓存 undici Agent 并做指纹比对回退（IP 直连 + 无 IP SAN 场景）；与「跳过校验」三层互斥。
- 模型设置：SSL 高级设置折叠区（默认收起、启用带徽标）。

## 26.0.4 (2026-10-10)

- 修复 `ProviderApiConfig` 值类剥落 TLS 字段导致钉扎/跳过配置不生效的问题。

## 26.0.3 (2026-10-10)

- 服务商级「跳过 TLS 证书校验」（`allowInsecureTls`）：Node fetch 不读 Windows 证书库，
  自签内网网关按端点显式放行，无全局开关。

## 26.0.2 (2026-10-09)

- 内嵌浏览器（IAB）下载静默落盘：不再弹「另存为」，自动保存 `Downloads/yazcode/`
  （重名加序号，fail-open 回退对话框）。

## 26.0.1 (2026-10-09)

- 修复 26.0.0 桌面启动卡死：renderer 打包图引入 Node `os` 顶层调用导致 React 不挂载
  （CDP 实锤定位）；`paths.ts` 改惰性求值，并新增「公共入口不得在初始化期触碰 node:os」约束。

## 26.0.0 (2026-10-08)

- **年份号段版本线起航**（`26.y.z`）。
- **记忆提供方三选一**：内置文件记忆 / OpenViking（语义召回 + 自动沉淀）/ 不启用，
  三态互斥、无静默回落；内置 Apache-2.0 的 OpenViking 客户端集成运行时
  （`vendor/openviking/`）与安装服务（连接校验含数据面验证）。
- `typecheck:cli` 扩展到全部 13 个 CLI 子包（此前 bootstrap 三处类型错误骗过本地门禁）。
