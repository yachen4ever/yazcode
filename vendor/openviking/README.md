# OpenViking 客户端集成运行时（vendored）

本目录是 [OpenViking](https://github.com/volcengine/OpenViking) 仓库
`examples/` 下客户端集成代码的 **vendored 副本**，供 yazcode 的「记忆提供方 =
OpenViking」档位使用。

## 许可与来源

- 版权：volcengine（火山引擎）
- 许可：**Apache License 2.0**（OpenViking 官方 README 的分组件许可声明：
  Main Project = AGPLv3，而 `examples/` = Apache 2.0）
- 来源仓库：https://github.com/volcengine/OpenViking
- 同步自：`examples/agent-hook-plugin`（裁剪为 zcode host）+
  `examples/memory-plugin-shared/lib`（按其 `MANIFEST` 全量）

**AGPL-3.0 不适用于本目录**：主项目的 AGPL 只覆盖 server 端，本目录是 Apache-2.0
的客户端集成代码，可随本项目闭源分发，只需保留版权与许可声明。

## 同步方式

1. 在 OpenViking 仓库执行 `node examples/memory-plugin-shared/sync.mjs` 生成 `shared/`
2. 用官方安装器装配到临时 HOME 后复制产物，或直接复制
   `examples/agent-hook-plugin`（剔除 `hosts/` 下 cursor / trae / kimicode）
   与 `examples/memory-plugin-shared/lib`
3. 删除 `integration.json`（机器特定安装记录）
4. 校验无本机绝对路径、地址与凭据残留

## 为什么 vendor 而不是运行时下载

- 办公机常年处于零信任内网，运行时下载多半不可达
- 离线可用的确定性优于「永远最新」

代价是 OpenViking 上游更新需要手工同步本目录。

## 结构

```
zcode/                      → <OPENVIKING_HOME>/agent-integrations/zcode/
  scripts/hook.mjs          4 个事件的统一入口
  scripts/uri-guard.mjs     viking:// 路径守卫
  servers/mcp-proxy.mjs     stdio MCP 代理
  hosts/zcode/hooks.json    hook 模板
  hosts/zcode/openviking.integration.json

memory-plugin-shared/lib/   → <OPENVIKING_HOME>/agent-integrations/memory-plugin-shared/lib/
  *.mjs                     24 个共享模块（recall / capture / credentials / …）
  MANIFEST                  模块清单
  install/                  官方 host-json-config.mjs 等安装辅助
```

`zcode/scripts` 与 `zcode/servers` 里的模块通过 `../../memory-plugin-shared/lib`
相对引用共享运行时，因此两个目录必须以同级关系部署在 `agent-integrations/` 下。

## 与官方安装器的差异

官方 `install.sh` 渲染的 hook 命令是 POSIX 内联赋值（`VAR='v' node script.mjs`），
Windows shell 不支持。yazcode 的安装服务会把配置里的 hook 命令改写为
`set "VAR=v" && node script.mjs`（仅 set 链用 `&&`，脚本与其参数用空格分隔）。