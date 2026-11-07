# Spec：浏览器控制主开关的禁用态可用性（26.5.5 发现 3）

## 背景

minttest 五轮（26.5.4）：全新配置首次进入浏览器控制页，「开启内置浏览器控制」开关
disabled 且无任何说明（其观察「创建首个脚本后自动变开启」为相关性误读——开关 disabled
的判定是 `pluginUnavailable = !workspacePath || loading || !browserUsePlugin`
（`BrowserSettingsSection.tsx`），首次进入时插件清单正异步初始化（loading=true），
初始化完成后自然恢复可点，与用户脚本无关）。

## 行为规则

1. **禁用必须可解释**：开关 disabled 的各原因在行 detail 槽给状态说明（三语）：
   - `loading`（插件清单初始化中）→「浏览器控制状态加载中…」
     （`settings.browser.control.loadingHint`）；
   - 清单已加载但插件缺失（`!browserUsePlugin && !loading` 且无 pluginError）→
     「浏览器控制插件未就绪，可稍后重试或重启应用后重进本页」
     （`settings.browser.control.unavailableHint`）；
   - `pluginError` 场景维持既有红色错误 detail（不叠加新说明）。
2. **保持禁用不放开**：加载中/未就绪时点击会在陈旧状态上操作；保持 disabled + 说明
   是正确语义（不采纳任务书「保持可点」备选路线，依据如上）。
3. `!workspacePath`（无宿主上下文）维持既有降级行为，本 spec 不新增面。

## 验收

1. 全新配置首进本页：开关 disabled 且出现「加载中」说明；初始化完成后说明消失、
   开关恢复可点；
2. 插件缺失态：出现「未就绪」说明，开关保持禁用；
3. 新增 key 三语集合一致。
