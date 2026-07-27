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
