import { useEffect, useRef, useState } from "react";
import { buildGenUiFileUrl, type GenUiReference } from "@zcode/shared/gen-ui";

const GEN_UI_MAX_HEIGHT_PX = 10_000;
const GEN_UI_MIN_HEIGHT_PX = 96;

/**
 * 会话内联可视化卡片（P1 只读链）。
 * guest 是内容测量的唯一来源：iframe 高度被动跟随 postMessage 上报，
 * 宿主不猜测内容几何；sandbox 只开脚本，不给同源/弹窗/顶层导航。
 */
export function GenUiCard({ reference }: { reference: GenUiReference }) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(GEN_UI_MIN_HEIGHT_PX);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as { type?: string; height?: unknown } | null;
      if (data?.type !== "zcode:gen-ui-size" || typeof data.height !== "number") return;
      if (!Number.isFinite(data.height) || data.height <= 0) return;
      const next = Math.min(Math.ceil(data.height), GEN_UI_MAX_HEIGHT_PX);
      setHeight((previous) => (previous === next ? previous : next));
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <figure className="my-2 w-full overflow-hidden rounded-lg border border-border">
      {reference.title ? (
        <figcaption className="border-b border-border px-3 py-1.5 text-foreground-subtle">
          {reference.title}
        </figcaption>
      ) : null}
      <iframe
        ref={iframeRef}
        src={buildGenUiFileUrl(reference.path)}
        sandbox="allow-scripts"
        title={reference.title ?? reference.path}
        className="block w-full border-0 bg-background"
        style={{ height }}
      />
    </figure>
  );
}
