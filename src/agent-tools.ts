import type { ToolDefinition, ToolCall } from "./openrouter";
import type { ToolRisk } from "./types";
import type { VaultTools } from "./vault-tools";
import type { VaultRetrievalIndex } from "./retrieval-index";
import type { SkillRegistry } from "./skill-registry";

export interface ToolExecutionResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface ToolPreview {
  title: string;
  before?: string;
  after?: string;
  details?: string;
}

export interface ToolInspection {
  sensitive: boolean;
  sensitivityReasons: string[];
  preview?: ToolPreview;
}

interface ToolExecutionOptions {
  allowSensitive: boolean;
}

interface RegisteredTool {
  definition: ToolDefinition;
  risk: ToolRisk;
  execute: (input: Record<string, unknown>, options: ToolExecutionOptions) => Promise<unknown>;
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

const booleanArg = (input: Record<string, unknown>, name: string, fallback = false): boolean => {
  const value = input[name];
  return typeof value === "boolean" ? value : fallback;
};

const stringArrayArg = (input: Record<string, unknown>, name: string): string[] | undefined => {
  const value = input[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Tool argument "${name}" must be an array of strings.`);
  }
  return value.map((item) => String(item).trim()).filter(Boolean);
};

const citationForPath = (path: string): string => `[[${path.replace(/\.md$/, "")}]]`;
const previewText = (value: string): string =>
  value.length <= 40_000 ? value : `${value.slice(0, 40_000)}\n[Preview truncated]`;

export class AgentToolRegistry {
  private readonly tools: Map<string, RegisteredTool>;

  constructor(
    private readonly vaultTools: VaultTools,
    private readonly retrievalIndex: VaultRetrievalIndex,
    private readonly skillRegistry: SkillRegistry
  ) {
    const registered: RegisteredTool[] = [
      {
        definition: {
          type: "function",
          function: {
            name: "get_environment",
            description: "Inspect the current Obsidian environment, capabilities, retrieval index, installed skills, active note, and access limits.",
            parameters: { type: "object", properties: {}, additionalProperties: false }
          }
        },
        risk: "read",
        execute: async () => ({
          ...this.vaultTools.getEnvironment(),
          retrieval: this.retrievalIndex.getStatus(),
          installedSkills: this.skillRegistry.list(),
          capabilities: [
            "render Obsidian Markdown including tables, links, callouts, code, and math",
            "inspect, list, read, search, and retrieve permitted Markdown notes",
            "create, append, patch, replace, rename, move, trash, and update frontmatter after approval",
            "discover and load traditional SKILL.md skills",
            "cite vault sources with clickable Obsidian wikilinks"
          ],
          limitations: [
            "no shell or unrestricted filesystem access",
            "no access to excluded paths",
            "direct sensitive note reads require approval; semantic retrieval follows the user's global semantic consent",
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
                limit: { type: "integer", minimum: 1, maximum: 200 }
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
            description: "Read one permitted Markdown note. Sensitive notes trigger a user approval gate. Cite the returned citation in the answer.",
            parameters: {
              type: "object",
              properties: { path: { type: "string", description: "Vault-relative Markdown path." } },
              required: ["path"],
              additionalProperties: false
            }
          }
        },
        risk: "read",
        execute: async (input, options) => {
          const path = stringArg(input, "path");
          return {
            path,
            citation: citationForPath(path),
            content: await this.vaultTools.readMarkdown(path, options.allowSensitive)
          };
        }
      },
      {
        definition: {
          type: "function",
          function: {
            name: "search_notes",
            description: "Search permitted non-sensitive Markdown notes for exact literal text. Cite returned citations.",
            parameters: {
              type: "object",
              properties: {
                query: { type: "string" },
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
            name: "retrieve_context",
            description: "Retrieve ranked vault excerpts using hybrid lexical and semantic search. Prefer this for conceptual vault questions and cite the exact returned wikilinks.",
            parameters: {
              type: "object",
              properties: {
                query: { type: "string", description: "Natural-language retrieval query." },
                mode: {
                  type: "string",
                  enum: ["hybrid", "semantic", "lexical"],
                  description: "Retrieval engine. Hybrid is the default."
                },
                limit: { type: "integer", minimum: 1, maximum: 20 },
                folders: { type: "array", items: { type: "string" } },
                tags: { type: "array", items: { type: "string" } },
                properties: {
                  type: "object",
                  description: "Exact frontmatter property filters.",
                  additionalProperties: { type: ["string", "number", "boolean"] }
                }
              },
              required: ["query"],
              additionalProperties: false
            }
          }
        },
        risk: "read",
        execute: async (input) => {
          const mode = typeof input.mode === "string" ? input.mode : "hybrid";
          if (!["hybrid", "semantic", "lexical"].includes(mode)) {
            throw new Error('Tool argument "mode" must be hybrid, semantic, or lexical.');
          }
          const properties = input.properties;
          if (properties !== undefined && (!properties || typeof properties !== "object" || Array.isArray(properties))) {
            throw new Error('Tool argument "properties" must be an object.');
          }
          return this.retrievalIndex.search(
            stringArg(input, "query"),
            numberArg(input, "limit", 8),
            {
              mode: mode as "hybrid" | "semantic" | "lexical",
              folders: stringArrayArg(input, "folders"),
              tags: stringArrayArg(input, "tags"),
              properties: properties as Record<string, string | number | boolean> | undefined
            }
          );
        }
      },
      {
        definition: {
          type: "function",
          function: {
            name: "create_note",
            description: "Create a Markdown note. Requires approval and shows the proposed content.",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string" },
                content: { type: "string" }
              },
              required: ["path", "content"],
              additionalProperties: false
            }
          }
        },
        risk: "high-write",
        execute: async (input) => {
          const file = await this.vaultTools.createMarkdown(stringArg(input, "path"), stringArg(input, "content", false));
          return { path: file.path, citation: citationForPath(file.path), created: true };
        }
      },
      {
        definition: {
          type: "function",
          function: {
            name: "append_note",
            description: "Append Markdown to an existing note without replacing its current content. Requires approval.",
            parameters: {
              type: "object",
              properties: { path: { type: "string" }, content: { type: "string" } },
              required: ["path", "content"],
              additionalProperties: false
            }
          }
        },
        risk: "high-write",
        execute: async (input) => {
          const path = stringArg(input, "path");
          await this.vaultTools.appendMarkdown(path, stringArg(input, "content", false));
          return { path, citation: citationForPath(path), appended: true };
        }
      },
      {
        definition: {
          type: "function",
          function: {
            name: "apply_note_patch",
            description: "Precisely replace exact text in an existing note. Prefer this over replacing a complete note. Requires approval with a before/after diff.",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string" },
                old_text: { type: "string" },
                new_text: { type: "string" },
                replace_all: { type: "boolean", description: "Replace every exact occurrence. Defaults to false." }
              },
              required: ["path", "old_text", "new_text"],
              additionalProperties: false
            }
          }
        },
        risk: "high-write",
        execute: async (input) => {
          const path = stringArg(input, "path");
          const result = await this.vaultTools.applyPatch(
            path,
            stringArg(input, "old_text"),
            stringArg(input, "new_text", false),
            booleanArg(input, "replace_all")
          );
          return { path, citation: citationForPath(path), ...result };
        }
      },
      {
        definition: {
          type: "function",
          function: {
            name: "replace_note",
            description: "Replace an entire note only when a precise patch is unsuitable. Requires approval with a content preview.",
            parameters: {
              type: "object",
              properties: { path: { type: "string" }, content: { type: "string" } },
              required: ["path", "content"],
              additionalProperties: false
            }
          }
        },
        risk: "high-write",
        execute: async (input) => {
          const path = stringArg(input, "path");
          await this.vaultTools.replaceMarkdown(path, stringArg(input, "content", false));
          return { path, citation: citationForPath(path), replaced: true };
        }
      },
      {
        definition: {
          type: "function",
          function: {
            name: "update_frontmatter",
            description: "Add or replace YAML frontmatter fields. Requires approval.",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string" },
                updates: { type: "object" }
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
          return { path, citation: citationForPath(path), updatedFields: Object.keys(updates) };
        }
      },
      {
        definition: {
          type: "function",
          function: {
            name: "rename_note",
            description: "Rename an existing Markdown note while preserving Obsidian links. Requires approval.",
            parameters: {
              type: "object",
              properties: { path: { type: "string" }, new_name: { type: "string" } },
              required: ["path", "new_name"],
              additionalProperties: false
            }
          }
        },
        risk: "high-write",
        execute: async (input) => {
          const result = await this.vaultTools.renameMarkdown(stringArg(input, "path"), stringArg(input, "new_name"));
          return { ...result, citation: citationForPath(result.to) };
        }
      },
      {
        definition: {
          type: "function",
          function: {
            name: "move_note",
            description: "Move an existing Markdown note to a new vault-relative .md path while preserving links. Requires approval.",
            parameters: {
              type: "object",
              properties: { path: { type: "string" }, destination: { type: "string" } },
              required: ["path", "destination"],
              additionalProperties: false
            }
          }
        },
        risk: "high-write",
        execute: async (input) => {
          const result = await this.vaultTools.moveMarkdown(stringArg(input, "path"), stringArg(input, "destination"));
          return { ...result, citation: citationForPath(result.to) };
        }
      },
      {
        definition: {
          type: "function",
          function: {
            name: "trash_note",
            description: "Move a permitted Markdown note to Obsidian's recoverable vault trash. Requires explicit approval.",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
              additionalProperties: false
            }
          }
        },
        risk: "destructive",
        execute: async (input) => this.vaultTools.trashMarkdown(stringArg(input, "path"))
      },
      {
        definition: {
          type: "function",
          function: {
            name: "list_skills",
            description: "List installed and discovered traditional SKILL.md skills. Listing a skill does not activate it for the conversation.",
            parameters: { type: "object", properties: {}, additionalProperties: false }
          }
        },
        risk: "read",
        execute: async () => this.skillRegistry.list()
      },
      {
        definition: {
          type: "function",
          function: {
            name: "load_skill",
            description: "Load one discovered SKILL.md body after its metadata indicates that it applies.",
            parameters: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
              additionalProperties: false
            }
          }
        },
        risk: "read",
        execute: async (input) => this.skillRegistry.load(stringArg(input, "name"))
      },
      {
        definition: {
          type: "function",
          function: {
            name: "read_skill_reference",
            description: "Read a Markdown reference inside an activated skill folder when its SKILL.md directs you to it.",
            parameters: {
              type: "object",
              properties: { name: { type: "string" }, path: { type: "string" } },
              required: ["name", "path"],
              additionalProperties: false
            }
          }
        },
        risk: "read",
        execute: async (input) => this.skillRegistry.readReference(stringArg(input, "name"), stringArg(input, "path"))
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

  async inspect(call: ToolCall): Promise<ToolInspection> {
    const input = this.parseArguments(call);
    let sensitive = false;
    let sensitivityReasons: string[] = [];
    let preview: ToolPreview | undefined;
    if (call.function.name === "read_note") {
      const report = await this.vaultTools.inspectSensitivity(stringArg(input, "path"));
      sensitive = report.sensitive;
      sensitivityReasons = report.reasons;
    } else if (call.function.name === "create_note") {
      preview = { title: `Create ${stringArg(input, "path")}`, before: "", after: previewText(stringArg(input, "content", false)) };
    } else if (call.function.name === "append_note") {
      preview = { title: `Append to ${stringArg(input, "path")}`, before: "", after: previewText(stringArg(input, "content", false)) };
    } else if (call.function.name === "apply_note_patch") {
      const result = await this.vaultTools.previewPatch(
        stringArg(input, "path"),
        stringArg(input, "old_text"),
        stringArg(input, "new_text", false),
        booleanArg(input, "replace_all")
      );
      preview = {
        title: `Patch ${stringArg(input, "path")}`,
        before: previewText(result.before),
        after: previewText(result.after),
        details: `${result.occurrences} exact occurrence${result.occurrences === 1 ? "" : "s"}`
      };
    } else if (call.function.name === "replace_note") {
      preview = {
        title: `Replace all content in ${stringArg(input, "path")}`,
        before: previewText(await this.vaultTools.readMarkdown(stringArg(input, "path"), true)),
        after: previewText(stringArg(input, "content", false))
      };
    } else if (call.function.name === "update_frontmatter") {
      preview = {
        title: `Update frontmatter in ${stringArg(input, "path")}`,
        details: JSON.stringify(objectInput(input.updates), null, 2)
      };
    } else if (call.function.name === "rename_note") {
      preview = { title: "Rename note", details: `${stringArg(input, "path")} → ${stringArg(input, "new_name")}` };
    } else if (call.function.name === "move_note") {
      preview = { title: "Move note", details: `${stringArg(input, "path")} → ${stringArg(input, "destination")}` };
    } else if (call.function.name === "trash_note") {
      preview = { title: "Move note to vault trash", details: stringArg(input, "path") };
    }
    return { sensitive, sensitivityReasons, preview };
  }

  async execute(call: ToolCall, options: ToolExecutionOptions = { allowSensitive: false }): Promise<ToolExecutionResult> {
    const tool = this.tools.get(call.function.name);
    if (!tool) return { ok: false, error: `Unknown tool: ${call.function.name}` };
    try {
      return { ok: true, result: await tool.execute(this.parseArguments(call), options) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
