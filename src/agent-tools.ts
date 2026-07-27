import type { ToolDefinition, ToolCall } from "./openrouter";
import type { ToolRisk } from "./types";
import type { VaultTools } from "./vault-tools";

export interface ToolExecutionResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface RegisteredTool {
  definition: ToolDefinition;
  risk: ToolRisk;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
}

const objectInput = (input: unknown): Record<string, unknown> => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Tool arguments must be a JSON object.");
  }
  return input as Record<string, unknown>;
};

const stringArg = (input: Record<string, unknown>, name: string, required = true): string => {
  const value = input[name];
  if (typeof value !== "string" || (required && !value.trim())) {
    throw new Error(`Tool argument "${name}" must be ${required ? "a non-empty" : "a"} string.`);
  }
  return value;
};

const numberArg = (input: Record<string, unknown>, name: string, fallback: number): number => {
  const value = input[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
};

export class AgentToolRegistry {
  private readonly tools: Map<string, RegisteredTool>;

  constructor(private readonly vaultTools: VaultTools) {
    const registered: RegisteredTool[] = [
      {
        definition: {
          type: "function",
          function: {
            name: "get_environment",
            description: "Inspect the current Obsidian environment, including vault name, active note, note count, and paths excluded from agent access.",
            parameters: { type: "object", properties: {}, additionalProperties: false }
          }
        },
        risk: "read",
        execute: async () => ({
          ...this.vaultTools.getEnvironment(),
          capabilities: [
            "inspect the current Obsidian environment",
            "list, read, and search permitted Markdown notes",
            "create Markdown notes after approval",
            "replace Markdown note content after approval",
            "update YAML frontmatter after approval"
          ],
          limitations: [
            "no shell or unrestricted filesystem access",
            "no access to excluded paths",
            "no write occurs without explicit approval"
          ]
        })
      },
      {
        definition: {
          type: "function",
          function: {
            name: "list_notes",
            description: "List permitted Markdown note paths, optionally restricted to a vault folder.",
            parameters: {
              type: "object",
              properties: {
                folder: { type: "string", description: "Optional vault-relative folder path." },
                limit: { type: "integer", minimum: 1, maximum: 200, description: "Maximum paths to return." }
              },
              additionalProperties: false
            }
          }
        },
        risk: "read",
        execute: async (input) => this.vaultTools.listMarkdown(
          typeof input.folder === "string" ? input.folder : "",
          numberArg(input, "limit", 100)
        )
      },
      {
        definition: {
          type: "function",
          function: {
            name: "read_note",
            description: "Read the full Markdown content of one permitted vault note.",
            parameters: {
              type: "object",
              properties: { path: { type: "string", description: "Vault-relative Markdown file path." } },
              required: ["path"],
              additionalProperties: false
            }
          }
        },
        risk: "read",
        execute: async (input) => ({
          path: stringArg(input, "path"),
          content: await this.vaultTools.readMarkdown(stringArg(input, "path"))
        })
      },
      {
        definition: {
          type: "function",
          function: {
            name: "search_notes",
            description: "Search permitted Markdown notes for literal text and return matching paths with nearby excerpts.",
            parameters: {
              type: "object",
              properties: {
                query: { type: "string", description: "Literal text to find, case-insensitive." },
                limit: { type: "integer", minimum: 1, maximum: 50 }
              },
              required: ["query"],
              additionalProperties: false
            }
          }
        },
        risk: "read",
        execute: async (input) => this.vaultTools.searchMarkdown(
          stringArg(input, "query"),
          Math.min(numberArg(input, "limit", 20), 50)
        )
      },
      {
        definition: {
          type: "function",
          function: {
            name: "create_note",
            description: "Create a new Markdown note at a safe, permitted vault-relative path. Requires user approval.",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string", description: "Vault-relative path ending in .md." },
                content: { type: "string", description: "Complete initial Markdown content." }
              },
              required: ["path", "content"],
              additionalProperties: false
            }
          }
        },
        risk: "high-write",
        execute: async (input) => {
          const file = await this.vaultTools.createMarkdown(
            stringArg(input, "path"),
            stringArg(input, "content", false)
          );
          return { path: file.path, created: true };
        }
      },
      {
        definition: {
          type: "function",
          function: {
            name: "replace_note",
            description: "Replace the complete Markdown content of an existing permitted note. Requires user approval.",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string", description: "Vault-relative Markdown file path." },
                content: { type: "string", description: "Complete replacement Markdown content." }
              },
              required: ["path", "content"],
              additionalProperties: false
            }
          }
        },
        risk: "high-write",
        execute: async (input) => {
          const path = stringArg(input, "path");
          await this.vaultTools.replaceMarkdown(path, stringArg(input, "content", false));
          return { path, replaced: true };
        }
      },
      {
        definition: {
          type: "function",
          function: {
            name: "update_frontmatter",
            description: "Add or replace YAML frontmatter fields on an existing permitted Markdown note. Requires user approval.",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string", description: "Vault-relative Markdown file path." },
                updates: { type: "object", description: "Frontmatter keys and JSON-compatible values." }
              },
              required: ["path", "updates"],
              additionalProperties: false
            }
          }
        },
        risk: "high-write",
        execute: async (input) => {
          const path = stringArg(input, "path");
          const updates = objectInput(input.updates);
          await this.vaultTools.updateFrontmatter(path, updates);
          return { path, updatedFields: Object.keys(updates) };
        }
      }
    ];
    this.tools = new Map(registered.map((tool) => [tool.definition.function.name, tool]));
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.definition);
  }

  riskFor(name: string): ToolRisk | null {
    return this.tools.get(name)?.risk ?? null;
  }

  parseArguments(call: ToolCall): Record<string, unknown> {
    try {
      return objectInput(JSON.parse(call.function.arguments));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid arguments for ${call.function.name}: ${message}`);
    }
  }

  async execute(call: ToolCall): Promise<ToolExecutionResult> {
    const tool = this.tools.get(call.function.name);
    if (!tool) return { ok: false, error: `Unknown tool: ${call.function.name}` };
    try {
      const result = await tool.execute(this.parseArguments(call));
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
