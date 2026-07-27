export type ToolRisk = "read" | "low-write" | "high-write" | "destructive";

export interface AgentTool<TInput = unknown, TResult = unknown> {
  name: string;
  description: string;
  risk: ToolRisk;
  execute(input: TInput): Promise<TResult>;
}

export interface MemoryFragment {
  id: string;
  category: "ability" | "habit" | "preference" | "goal" | "workflow" | "other";
  content: string;
  confidence: number;
  sensitivity: "low" | "review";
  createdAt: string;
  source: string;
  status: "active" | "superseded" | "revoked";
}

export interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: Record<string, string>;
  supported_parameters?: string[];
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
    tokenizer?: string;
  };
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number;
  };
}
