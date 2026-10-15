import {
  modelMessageContentToText,
  type ModelInputMessage,
} from "@zcode/contracts";

/**
 * OpenAI 兼容端点的 system 消息归一。
 *
 * 部分旧式 chat template（vLLM/Qwen 模板等）严格要求 system 必须出现在消息序列
 * 开头——而 ZCode 的注入时机（如技能列表在首个 user 之后追加）会把 system 放进
 * 消息中段，严格后端直接 400（"System message must be at the beginning"）。
 *
 * 归一规则：
 * - 开头连续的多个 system 合并为一个（Anthropic cache boundary 在 openai-compat
 *   序列化边界无意义，按原顺序拼接）；
 * - 中段 system（user/assistant 之后出现的）按原相对顺序**前移**到开头 system 之后
 *   ——system 语义上就是全局指令，前移不改变信息，只改变位置以适配严格模板。
 */
export function normalizeOpenAiCompatibleSystemMessages(
  messages: readonly ModelInputMessage[],
): ModelInputMessage[] {
  let leadingSystemCount = 0;
  while (messages[leadingSystemCount]?.role === "system") {
    leadingSystemCount += 1;
  }

  // 收集中段 system（保持原相对顺序），其余消息按原顺序排列。
  const midSystemMessages: ModelInputMessage[] = [];
  const rest: ModelInputMessage[] = [];
  for (let index = leadingSystemCount; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role === "system") {
      midSystemMessages.push(message);
    } else {
      rest.push(message);
    }
  }

  if (midSystemMessages.length === 0 && leadingSystemCount <= 1) {
    return [...messages];
  }

  const leadingSystemMessages = messages.slice(0, leadingSystemCount);
  const lastLeadingSystem = leadingSystemMessages.at(-1);

  // 开头连续段按原顺序合并为一个（每个后续 block 自带左边界，adapter 不推断或补写空白）。
  const leading =
    leadingSystemCount > 0
      ? [
          {
            role: "system" as const,
            content: leadingSystemMessages
              .map((message) => modelMessageContentToText(message.content))
              .join(""),
            ...(lastLeadingSystem?.cacheControl
              ? { cacheControl: { ...lastLeadingSystem.cacheControl } }
              : {}),
          },
        ]
      : [];

  // 中段 system 前置为独立 system 消息（保持原相对顺序；cacheControl 在
  // openai-compat 序列化边界无意义，丢弃）。
  const relocated = midSystemMessages.map((message) => ({
    role: "system" as const,
    content: modelMessageContentToText(message.content),
  }));

  return [...leading, ...relocated, ...rest];
}
