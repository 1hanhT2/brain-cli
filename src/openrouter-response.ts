export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatCitation {
  url: string;
  title?: string;
}

export interface ChatCompletionResult {
  content: string;
  finishReason: string | null;
  toolCalls: ToolCall[];
  citations: ChatCitation[];
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

export const parseBufferedChatCompletion = (
  value: unknown,
  onContent: (content: string) => void = () => undefined
): ChatCompletionResult => {
  const body = record(value);
  const error = record(body.error);
  if (Object.keys(error).length > 0) {
    throw new Error(`OpenRouter completion error: ${typeof error.message === "string" ? error.message : "Unknown provider error."}`);
  }
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const choice = record(choices[0]);
  const message = record(choice.message);
  const content = typeof message.content === "string" ? message.content : "";
  if (content) onContent(content);
  const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const toolCalls = rawToolCalls.map((entry, index): ToolCall => {
    const call = record(entry);
    const fn = record(call.function);
    const name = typeof fn.name === "string" ? fn.name : "";
    if (!name) throw new Error("OpenRouter returned a tool call without a function name.");
    const rawArguments = fn.arguments;
    return {
      id: typeof call.id === "string" && call.id ? call.id : `brain_tool_${Date.now()}_${index}`,
      type: "function",
      function: {
        name,
        arguments: typeof rawArguments === "string"
          ? rawArguments || "{}"
          : JSON.stringify(rawArguments ?? {})
      }
    };
  });
  const citations: ChatCitation[] = [];
  const annotations = Array.isArray(message.annotations) ? message.annotations : [];
  for (const entry of annotations) {
    const annotation = record(entry);
    if (annotation.type !== "url_citation") continue;
    const citation = record(annotation.url_citation);
    const url = typeof citation.url === "string" ? citation.url : "";
    if (!url) continue;
    citations.push({
      url,
      title: typeof citation.title === "string" ? citation.title : undefined
    });
  }
  return {
    content,
    finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : null,
    toolCalls,
    citations
  };
};
