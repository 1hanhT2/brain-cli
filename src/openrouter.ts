import { requestUrl, type App } from "obsidian";
import type { OpenRouterModel } from "./types";
import type { OpenRouterRequestTool } from "./openrouter-tools";

export type { FunctionToolDefinition as ToolDefinition } from "./openrouter-tools";

interface ModelListResponse {
  data?: OpenRouterModel[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type ChatMessage =
  | {
      role: "system" | "user";
      content: string;
    }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: ToolCall[];
    }
  | {
      role: "tool";
      content: string;
      tool_call_id: string;
      name?: string;
    };

interface StreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
  error?: {
    code?: number | string;
    message?: string;
  };
}

interface OpenRouterErrorBody {
  error?: {
    code?: number | string;
    message?: string;
  };
}

interface TextCompletionResponse extends OpenRouterErrorBody {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
}

export interface ChatCompletionResult {
  content: string;
  finishReason: string | null;
  toolCalls: ToolCall[];
}

const CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";

export class OpenRouterClient {
  constructor(private readonly app: App, private readonly getSecretId: () => string) {}

  async listModels(): Promise<OpenRouterModel[]> {
    const apiKey = await this.getApiKey();

    const response = await requestUrl({
      url: "https://openrouter.ai/api/v1/models",
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    const body = response.json as ModelListResponse;
    if (!Array.isArray(body.data)) throw new Error("OpenRouter returned an invalid model catalog.");
    return body.data
      .filter((model) => Boolean(model.id))
      .sort((left, right) => (left.name ?? left.id).localeCompare(right.name ?? right.id));
  }

  async streamChatCompletion(
    model: string,
    messages: ChatMessage[],
    tools: OpenRouterRequestTool[],
    onDelta: (delta: string) => void,
    signal: AbortSignal
  ): Promise<ChatCompletionResult> {
    if (!model.trim()) throw new Error("Choose an OpenRouter model first.");
    if (messages.length === 0) throw new Error("A chat completion requires at least one message.");
    const apiKey = await this.getApiKey();
    const response = await fetch(CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-OpenRouter-Title": "Obsidian Brain"
      },
      body: JSON.stringify({
        model,
        messages,
        tools,
        tool_choice: "auto",
        parallel_tool_calls: false,
        stream: true
      }),
      signal
    });

    if (!response.ok) throw new Error(await this.readHttpError(response));
    if (!response.body) throw new Error("This Obsidian runtime did not expose the OpenRouter response stream.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let finishReason: string | null = null;
    const streamedToolCalls = new Map<number, {
      id: string;
      name: string;
      arguments: string;
    }>();

    const consumeLine = (rawLine: string): boolean => {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) return false;
      const data = line.slice(5).trimStart();
      if (data === "[DONE]") return true;
      if (!data) return false;

      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(data) as StreamChunk;
      } catch {
        throw new Error("OpenRouter returned a malformed streaming event.");
      }
      if (chunk.error) {
        const code = chunk.error.code ? ` (${chunk.error.code})` : "";
        throw new Error(`OpenRouter stream error${code}: ${chunk.error.message ?? "Unknown provider error."}`);
      }

      const choice = chunk.choices?.[0];
      const delta = choice?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) {
        content += delta;
        onDelta(delta);
      }
      for (const toolDelta of choice?.delta?.tool_calls ?? []) {
        const accumulated = streamedToolCalls.get(toolDelta.index) ?? {
          id: "",
          name: "",
          arguments: ""
        };
        if (toolDelta.id) accumulated.id = toolDelta.id;
        if (toolDelta.function?.name) accumulated.name += toolDelta.function.name;
        if (toolDelta.function?.arguments) accumulated.arguments += toolDelta.function.arguments;
        streamedToolCalls.set(toolDelta.index, accumulated);
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      return false;
    };

    const result = (): ChatCompletionResult => ({
      content,
      finishReason,
      toolCalls: [...streamedToolCalls.entries()]
        .sort(([left], [right]) => left - right)
        .map(([index, call]) => ({
          id: call.id || `brain_tool_${Date.now()}_${index}`,
          type: "function",
          function: {
            name: call.name,
            arguments: call.arguments || "{}"
          }
        }))
    });

    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });

        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (consumeLine(line)) return result();
          newline = buffer.indexOf("\n");
        }

        if (done) {
          if (buffer.trim() && consumeLine(buffer)) return result();
          break;
        }
      }
      return result();
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  async completeText(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    signal: AbortSignal
  ): Promise<string> {
    const apiKey = await this.getApiKey();
    const response = await fetch(CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-OpenRouter-Title": "Obsidian Brain"
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        max_tokens: 1_024,
        stream: false
      }),
      signal
    });
    if (!response.ok) throw new Error(await this.readHttpError(response));
    const body = await response.json() as TextCompletionResponse;
    if (body.error) {
      throw new Error(`OpenRouter completion error: ${body.error.message ?? "Unknown provider error."}`);
    }
    const content = body.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("The summarization model returned no text.");
    return content;
  }

  private async getApiKey(): Promise<string> {
    const secretId = this.getSecretId().trim();
    if (!secretId) throw new Error("Choose an OpenRouter API key in Obsidian Brain settings first.");
    const apiKey = await this.app.secretStorage.getSecret(secretId);
    if (!apiKey) throw new Error("The selected OpenRouter secret is unavailable on this device.");
    return apiKey;
  }

  private async readHttpError(response: Response): Promise<string> {
    let message = response.statusText || "Request failed";
    try {
      const body = await response.json() as OpenRouterErrorBody;
      if (body.error?.message) message = body.error.message;
    } catch {
      // Some gateways return a non-JSON error page. The status remains actionable.
    }
    return `OpenRouter request failed (${response.status}): ${message}`;
  }
}
