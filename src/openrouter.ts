import { requestUrl, type App } from "obsidian";
import type { OpenRouterModel } from "./types";
import {
  legacyWebPluginFor,
  splitOpenRouterTools,
  type OpenRouterRequestTool
} from "./openrouter-tools";
import type { DailyModelRanking } from "./model-rankings";
import type { EmbeddingBatchResult, EmbeddingModel } from "./semantic-types";
import { compactEmbeddingModel, compactOpenRouterModel } from "./catalog-models";

export type { FunctionToolDefinition as ToolDefinition } from "./openrouter-tools";

interface ModelListResponse {
  data?: OpenRouterModel[];
}

interface DailyRankingResponse {
  data?: DailyModelRanking[];
}

interface EmbeddingModelListResponse {
  data?: EmbeddingModel[];
}

interface EmbeddingResponse extends OpenRouterErrorBody {
  data?: Array<{ embedding?: number[]; index?: number }>;
  usage?: {
    prompt_tokens?: number;
    total_tokens?: number;
  };
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
    metadata?: {
      provider_name?: string;
      raw?: string;
    };
  };
}

interface TextCompletionResponse extends OpenRouterErrorBody {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface TextCompletionResult {
  content: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatCompletionResult {
  content: string;
  finishReason: string | null;
  toolCalls: ToolCall[];
}

const CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";
const EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";

export class OpenRouterClient {
  private readonly rankingCache = new Map<string, {
    expiresAt: number;
    rows: DailyModelRanking[];
  }>();

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
      .map(compactOpenRouterModel)
      .sort((left, right) => (left.name ?? left.id).localeCompare(right.name ?? right.id));
  }

  async listEmbeddingModels(): Promise<EmbeddingModel[]> {
    const apiKey = await this.getApiKey();
    const embeddingModels: EmbeddingModel[] = [];
    for (let offset = 0; offset < 10_000; offset += 1_000) {
      const query = new URLSearchParams({ limit: "1000", offset: String(offset) });
      const response = await requestUrl({
        url: `${EMBEDDINGS_URL}/models?${query.toString()}`,
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      const body = response.json as EmbeddingModelListResponse;
      if (!Array.isArray(body.data)) throw new Error("OpenRouter returned an invalid embedding model catalog.");
      embeddingModels.push(...body.data);
      if (body.data.length < 1_000) break;
    }

    // The general model catalog currently carries the most complete pricing
    // information, so merge it without making pricing a hard dependency.
    let pricingById = new Map<string, Record<string, string>>();
    try {
      const generalModels = this.modelCatalogFromResponse(await requestUrl({
        url: "https://openrouter.ai/api/v1/models",
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` }
      }).then((result) => result.json as ModelListResponse));
      pricingById = new Map(generalModels
        .filter((model) => model.pricing)
        .map((model) => [model.id, model.pricing!]));
    } catch (error) {
      console.warn("[Brain CLI] Embedding pricing metadata could not be refreshed.", error);
    }

    return [...new Map(embeddingModels
      .filter((model) => Boolean(model.id))
      .map((model) => [model.id, model])).values()]
      .map((model) => ({ ...model, pricing: model.pricing ?? pricingById.get(model.id) }))
      .map(compactEmbeddingModel)
      .sort((left, right) => (left.name ?? left.id).localeCompare(right.name ?? right.id));
  }

  async embed(
    model: string,
    inputs: string[],
    signal: AbortSignal
  ): Promise<EmbeddingBatchResult> {
    if (!model.trim()) throw new Error("Choose an OpenRouter embedding model first.");
    if (inputs.length === 0) return { vectors: [], promptTokens: 0, totalTokens: 0 };
    const apiKey = await this.getApiKey();
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let retryable = true;
      try {
        const response = await fetch(EMBEDDINGS_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "X-OpenRouter-Title": "Brain CLI"
          },
          body: JSON.stringify({
            model,
            input: inputs,
            encoding_format: "float",
            truncate: "END"
          }),
          signal
        });
        if (!response.ok) {
          const message = await this.readHttpError(response);
          if ((response.status === 429 || response.status >= 500) && attempt < 2) {
            lastError = new Error(message);
            await this.retryDelay(500 * (2 ** attempt), signal);
            continue;
          }
          retryable = false;
          throw new Error(message);
        }
        const body = await response.json() as EmbeddingResponse;
        if (body.error) {
          retryable = false;
          throw new Error(`OpenRouter embedding error: ${body.error.message ?? "Unknown provider error."}`);
        }
        const rows = [...(body.data ?? [])].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
        if (rows.length !== inputs.length || rows.some((row) => !Array.isArray(row.embedding))) {
          throw new Error("OpenRouter returned an incomplete embedding batch.");
        }
        return {
          vectors: rows.map((row) => Float32Array.from(row.embedding!)),
          promptTokens: body.usage?.prompt_tokens ?? 0,
          totalTokens: body.usage?.total_tokens ?? body.usage?.prompt_tokens ?? 0
        };
      } catch (error) {
        if (signal.aborted) throw error;
        lastError = error;
        if (retryable && attempt < 2) {
          await this.retryDelay(500 * (2 ** attempt), signal);
          continue;
        }
        break;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("OpenRouter embedding request failed.");
  }

  async listDailyModelRankings(startDate: string, endDate: string): Promise<DailyModelRanking[]> {
    const cacheKey = `${startDate}:${endDate}`;
    const cached = this.rankingCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return [...cached.rows];
    const apiKey = await this.getApiKey();
    const query = new URLSearchParams({
      start_date: startDate,
      end_date: endDate
    });
    const response = await requestUrl({
      url: `https://openrouter.ai/api/v1/datasets/rankings-daily?${query.toString()}`,
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    const body = response.json as DailyRankingResponse;
    if (!Array.isArray(body.data)) throw new Error("OpenRouter returned invalid model ranking data.");
    const rows = body.data.filter((row) =>
      typeof row.date === "string"
      && typeof row.model_permaslug === "string"
      && typeof row.total_tokens === "string"
    );
    this.rankingCache.set(cacheKey, {
      expiresAt: Date.now() + 15 * 60 * 1000,
      rows
    });
    return [...rows];
  }

  clearModelRankingCache(): void {
    this.rankingCache.clear();
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
    const request = (body: Record<string, unknown>) => fetch(CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-OpenRouter-Title": "Brain CLI"
      },
      body: JSON.stringify(body),
      signal
    });

    const baseBody = {
      model,
      messages,
      tools,
      tool_choice: "auto",
      parallel_tool_calls: false,
      stream: true
    };
    let response = await request(baseBody);
    if (!response.ok) {
      const primaryStatus = response.status;
      const primaryError = await this.readHttpError(response);
      const { functionTools, webSearchTool } = splitOpenRouterTools(tools);
      if (primaryStatus >= 500 && webSearchTool) {
        console.warn(
          "[Brain CLI] OpenRouter's web-search server tool failed; retrying with the legacy web plugin.",
          primaryError
        );
        response = await request({
          ...baseBody,
          tools: functionTools,
          plugins: [legacyWebPluginFor(webSearchTool)]
        });
        if (!response.ok) {
          const fallbackError = await this.readHttpError(response);
          throw new Error(`${fallbackError} Legacy web-search retry followed: ${primaryError}`);
        }
      } else {
        throw new Error(primaryError);
      }
    }
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
    return (await this.completeTextWithUsage(model, systemPrompt, userPrompt, signal)).content;
  }

  async completeTextWithUsage(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    signal: AbortSignal
  ): Promise<TextCompletionResult> {
    const apiKey = await this.getApiKey();
    const response = await fetch(CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-OpenRouter-Title": "Brain CLI"
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
    return {
      content,
      promptTokens: body.usage?.prompt_tokens ?? Math.ceil((systemPrompt.length + userPrompt.length) / 4),
      completionTokens: body.usage?.completion_tokens ?? Math.ceil(content.length / 4),
      totalTokens: body.usage?.total_tokens
        ?? (body.usage?.prompt_tokens ?? Math.ceil((systemPrompt.length + userPrompt.length) / 4))
          + (body.usage?.completion_tokens ?? Math.ceil(content.length / 4))
    };
  }

  private async getApiKey(): Promise<string> {
    const secretId = this.getSecretId().trim();
    if (!secretId) throw new Error("Choose an OpenRouter API key in Brain CLI settings first.");
    const apiKey = await this.app.secretStorage.getSecret(secretId);
    if (!apiKey) throw new Error("The selected OpenRouter secret is unavailable on this device.");
    return apiKey;
  }

  private modelCatalogFromResponse(body: ModelListResponse): OpenRouterModel[] {
    if (!Array.isArray(body.data)) throw new Error("OpenRouter returned an invalid model catalog.");
    return body.data.filter((model) => Boolean(model.id)).map(compactOpenRouterModel);
  }

  private retryDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(resolve, milliseconds);
      signal.addEventListener("abort", () => {
        window.clearTimeout(timeout);
        reject(new DOMException("The operation was aborted.", "AbortError"));
      }, { once: true });
    });
  }

  private async readHttpError(response: Response): Promise<string> {
    let message = response.statusText || "Request failed";
    let details = "";
    try {
      const body = await response.json() as OpenRouterErrorBody;
      if (body.error?.message) message = body.error.message;
      const provider = body.error?.metadata?.provider_name;
      const raw = body.error?.metadata?.raw;
      details = [
        provider ? `provider=${provider}` : "",
        raw ? `upstream=${raw.slice(0, 500)}` : ""
      ].filter(Boolean).join(", ");
    } catch {
      // Some gateways return a non-JSON error page. The status remains actionable.
    }
    return `OpenRouter request failed (${response.status}): ${message}${details ? ` [${details}]` : ""}`;
  }
}
