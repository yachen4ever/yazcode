import { memo, useMemo } from "react";
import { projectGenUiReferences } from "@/lib/genUiReferences.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { MessageResponse, type MessageResponseProps } from "@/components/ai-elements/message.js";
import { GenUiCard } from "./GenUiCard.js";

type GenUiMessageResponseProps = Omit<MessageResponseProps, "children"> & {
  children: string;
};

/**
 * assistant 正文的 Gen UI 投影：文本段仍走 MessageResponse（streamdown），
 * ::visualize 引用段替换为内联可视化卡片；流式中的半截引用进入等待态，
 * 完成后仍未通过 schema 的引用显示为无效态，不吞正文、不渲染代码块内的示例。
 */
export const GenUiMessageResponse = memo(function GenUiMessageResponse({
  children,
  ...props
}: GenUiMessageResponseProps) {
  const { intl } = useZCodeIntl();
  const parts = useMemo(
    () => projectGenUiReferences(children, props.streaming !== true),
    [children, props.streaming],
  );
  const hasUiParts = parts.some((part) => part.kind !== "text");
  if (!hasUiParts) {
    return <MessageResponse {...props}>{children}</MessageResponse>;
  }
  return (
    <>
      {parts.map((part, index) =>
        part.kind === "text" ? (
          <MessageResponse {...props} key={`text:${index}`}>
            {part.text}
          </MessageResponse>
        ) : part.kind === "ui" ? (
          <GenUiCard key={`ui:${index}`} reference={part.reference} />
        ) : (
          <div
            key={`status:${index}`}
            className="my-2 rounded-lg border border-border p-3 text-foreground-subtle"
          >
            {intl.formatMessage({
              id:
                part.kind === "pending"
                  ? props.streaming
                    ? "genUi.waiting"
                    : "genUi.incomplete"
                  : "genUi.invalid",
            })}
          </div>
        ),
      )}
    </>
  );
});
