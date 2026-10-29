import { useRef } from "react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * P4 工具行：新建 / 导入 / 从 URL 安装三个入口。
 * 仅在 statusAvailable（桌面宿主）时由设置卡渲染；无宿主环境保持 P3 的只读降级
 * （P4 验收 12）。导入用渲染进程 `<input type="file">` + file.text() 读内容，
 * 不扩 main 的任意路径读面（spec P4 行为规则 5）。
 */
export function IabUserscriptToolsRow({
  onCreate,
  onImportFile,
  onInstallFromUrl,
}: {
  onCreate: () => void;
  onImportFile: (file: File) => void;
  onInstallFromUrl: () => void;
}) {
  const { intl } = useZCodeIntl();
  const inputRef = useRef<HTMLInputElement>(null);

  // 读取后立刻清空 value：允许连续导入同一文件（同一 file 第二次 change 不触发）。
  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (file) onImportFile(file);
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
      <input
        ref={inputRef}
        type="file"
        accept=".user.js"
        className="hidden"
        onChange={handleFileChange}
      />
      <Button type="button" variant="outline" size="sm" onClick={onCreate}>
        {intl.formatMessage({ id: "settings.userscripts.tools.new" })}
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={() => inputRef.current?.click()}>
        {intl.formatMessage({ id: "settings.userscripts.tools.import" })}
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={onInstallFromUrl}>
        {intl.formatMessage({ id: "settings.userscripts.tools.installUrl" })}
      </Button>
    </div>
  );
}
