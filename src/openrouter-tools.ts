export interface FunctionToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OpenRouterWebSearchTool {
  type: "openrouter:web_search";
  parameters: {
    engine: "auto";
    max_results: number;
  };
}

export type OpenRouterRequestTool = FunctionToolDefinition | OpenRouterWebSearchTool;

export interface LegacyOpenRouterWebPlugin {
  id: "web";
  max_results: number;
}

export const splitOpenRouterTools = (
  tools: OpenRouterRequestTool[]
): {
  functionTools: FunctionToolDefinition[];
  webSearchTool: OpenRouterWebSearchTool | null;
} => ({
  functionTools: tools.filter((tool): tool is FunctionToolDefinition => tool.type === "function"),
  webSearchTool: tools.find(
    (tool): tool is OpenRouterWebSearchTool => tool.type === "openrouter:web_search"
  ) ?? null
});

export const legacyWebPluginFor = (
  tool: OpenRouterWebSearchTool
): LegacyOpenRouterWebPlugin => ({
  id: "web",
  max_results: tool.parameters.max_results
});

export const assembleOpenRouterTools = (
  functionTools: FunctionToolDefinition[],
  webSearchEnabled: boolean
): OpenRouterRequestTool[] => [
  ...(webSearchEnabled
    ? [{
        type: "openrouter:web_search" as const,
        parameters: {
          engine: "auto" as const,
          max_results: 5
        }
      }]
    : []),
  ...functionTools
];
