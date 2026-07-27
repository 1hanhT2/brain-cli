import type { ChatMessage } from "./openrouter";

const SUMMARY_PREFIX = "[Conversation summary]";

const messageText = (message: ChatMessage): string => {
  if (message.role === "tool") {
    return `TOOL ${message.name ?? "unknown"}: ${message.content}`;
  }
  const toolCalls = message.role === "assistant"
    ? (message.tool_calls ?? []).map((call) =>
      `TOOL REQUEST ${call.function.name}: ${call.function.arguments}`
    ).join("\n")
    : "";
  return `${message.role.toUpperCase()}: ${message.content ?? ""}${toolCalls ? `\n${toolCalls}` : ""}`;
};

export const estimateMessageTokens = (messages: ChatMessage[]): number =>
  Math.ceil(messages.reduce((total, message) => total + messageText(message).length, 0) / 4);

export interface ContextCompactionResult {
  messages: ChatMessage[];
  compacted: boolean;
  summarizedMessages: number;
}

export async function compactConversation(
  messages: ChatMessage[],
  contextLength: number,
  summarize: (transcript: string) => Promise<string>
): Promise<ContextCompactionResult> {
  const outputReserve = Math.min(4_096, Math.max(1_024, Math.floor(contextLength * 0.2)));
  const usableTokens = Math.max(1_024, Math.floor(contextLength * 0.8) - outputReserve);
  if (estimateMessageTokens(messages) <= usableTokens) {
    return { messages, compacted: false, summarizedMessages: 0 };
  }

  const baseSystem = messages.find((message) =>
    message.role === "system" && !message.content.startsWith(SUMMARY_PREFIX)
  );
  const existingSummary = messages.find((message) =>
    message.role === "system" && message.content.startsWith(SUMMARY_PREFIX)
  );
  const conversational = messages.filter((message) => message.role !== "system");
  const userIndexes = conversational
    .map((message, index) => message.role === "user" ? index : -1)
    .filter((index) => index >= 0);
  const keepFrom = userIndexes.length > 4 ? userIndexes[userIndexes.length - 4] : Math.floor(conversational.length / 2);
  const oldMessages = conversational.slice(0, keepFrom);
  const recentMessages = conversational.slice(keepFrom);
  if (oldMessages.length === 0) {
    return {
      messages: trimOversizedMessages(messages, usableTokens),
      compacted: true,
      summarizedMessages: 0
    };
  }

  const transcript = [
    existingSummary?.content ?? "",
    ...oldMessages.map(messageText)
  ].filter(Boolean).join("\n\n").slice(-120_000);
  let summary: string;
  try {
    summary = await summarize(transcript);
  } catch (error) {
    if (
      error instanceof DOMException
      ? error.name === "AbortError"
      : error instanceof Error && error.name === "AbortError"
    ) {
      throw error;
    }
    summary = oldMessages
      .map(messageText)
      .join("\n")
      .slice(-20_000);
  }

  const compacted: ChatMessage[] = [
    ...(baseSystem ? [baseSystem] : []),
    {
      role: "system",
      content: `${SUMMARY_PREFIX}\n${summary}`
    },
    ...recentMessages
  ];
  return {
    messages: trimOversizedMessages(compacted, usableTokens),
    compacted: true,
    summarizedMessages: oldMessages.length
  };
}

const trimOversizedMessages = (messages: ChatMessage[], tokenBudget: number): ChatMessage[] => {
  const baseSystem = messages[0]?.role === "system" ? messages[0] : null;
  const rest = baseSystem ? messages.slice(1) : messages;
  const systemCharacters = baseSystem ? messageText(baseSystem).length : 0;
  let remaining = Math.max(0, tokenBudget * 4 - systemCharacters);
  const reversed = [...rest].reverse().map((message) => {
    const text = messageText(message);
    if (text.length <= remaining) {
      remaining -= text.length;
      return message;
    }
    if (message.role === "tool") {
      const keep = Math.max(0, remaining);
      remaining = 0;
      return {
        ...message,
        content: `[Earlier tool result trimmed]\n${keep > 0 ? message.content.slice(-keep) : ""}`
      };
    }
    if (message.role === "assistant" || message.role === "user" || message.role === "system") {
      const keep = Math.max(0, remaining);
      remaining = 0;
      return {
        ...message,
        content: `[Earlier content trimmed]\n${keep > 0 ? (message.content ?? "").slice(-keep) : ""}`
      } as ChatMessage;
    }
    return message;
  });
  return [...(baseSystem ? [baseSystem] : []), ...reversed.reverse()];
};
