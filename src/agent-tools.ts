import type { ToolDefinition, ToolCall } from "./openrouter";
import type { ToolRisk } from "./types";
import type { VaultTools } from "./vault-tools";
import type { VaultRetrievalIndex } from "./retrieval-index";
import type { SkillRegistry } from "./skill-registry";
import type { TaskService } from "./task-service";
import {
  taskDisplayTitle,
  type BrainTask,
  type TaskCreateInput,
  type TaskPatch,
  type TaskQuery
} from "./task-provider";
import type { ExpService } from "./exp-service";
import type { ExpAction, ExpFactors, ExpRecordInput, TaskExpState } from "./exp-core";

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

const nullableStringArg = (input: Record<string, unknown>, name: string): string | null | undefined => {
  const value = input[name];
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") throw new Error(`Tool argument "${name}" must be a string or null.`);
  return value.trim();
};

const nullableNumberArg = (input: Record<string, unknown>, name: string): number | null | undefined => {
  const value = input[name];
  if (value === undefined || value === null) return value;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Tool argument "${name}" must be a non-negative number or null.`);
  }
  return value;
};

const dependencyArrayArg = (
  input: Record<string, unknown>,
  name: string
): Array<{ uid: string; reltype?: string }> | undefined => {
  const value = input[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`Tool argument "${name}" must be an array.`);
  return value.map((entry, index) => {
    const dependency = objectInput(entry);
    const uid = stringArg(dependency, "uid");
    const reltype = dependency.reltype;
    if (reltype !== undefined && typeof reltype !== "string") {
      throw new Error(`Tool argument "${name}[${index}].reltype" must be a string.`);
    }
    return { uid, ...(typeof reltype === "string" && reltype.trim() ? { reltype: reltype.trim() } : {}) };
  });
};

const taskFields = (input: Record<string, unknown>): TaskPatch => ({
  ...(input.title !== undefined ? { title: stringArg(input, "title") } : {}),
  ...(input.status !== undefined ? { status: stringArg(input, "status") } : {}),
  ...(input.priority !== undefined ? { priority: stringArg(input, "priority") } : {}),
  ...(input.due !== undefined ? { due: nullableStringArg(input, "due") } : {}),
  ...(input.scheduled !== undefined ? { scheduled: nullableStringArg(input, "scheduled") } : {}),
  ...(input.tags !== undefined ? { tags: stringArrayArg(input, "tags") } : {}),
  ...(input.contexts !== undefined ? { contexts: stringArrayArg(input, "contexts") } : {}),
  ...(input.projects !== undefined ? { projects: stringArrayArg(input, "projects") } : {}),
  ...(input.time_estimate !== undefined ? { timeEstimate: nullableNumberArg(input, "time_estimate") } : {}),
  ...(input.recurrence !== undefined ? { recurrence: nullableStringArg(input, "recurrence") } : {}),
  ...(input.blocked_by !== undefined ? { dependencies: dependencyArrayArg(input, "blocked_by") } : {})
});

const expInput = (input: Record<string, unknown>): ExpRecordInput => {
  const action = stringArg(input, "action") as ExpAction;
  if (!["plan", "award", "recalibrate"].includes(action)) {
    throw new Error('Tool argument "action" must be plan, award, or recalibrate.');
  }
  const rawFactors = objectInput(input.factors);
  const factors = Object.fromEntries(
    ["output", "difficulty", "rigor", "friction", "independence", "significance"]
      .map((name) => [name, stringArg(rawFactors, name)])
  ) as unknown as ExpFactors;
  return {
    path: stringArg(input, "path"),
    action,
    value: numberArg(input, "value", Number.NaN),
    confidence: numberArg(input, "confidence", Number.NaN),
    reason: stringArg(input, "reason"),
    factors,
    allowRepeat: booleanArg(input, "allow_repeat")
  };
};

const citationForPath = (path: string): string => `[[${path.replace(/\.md$/, "")}]]`;
const previewText = (value: string): string =>
  value.length <= 40_000 ? value : `${value.slice(0, 40_000)}\n[Preview truncated]`;

type TaskPreviewInput = Partial<Omit<BrainTask, "dependencies">> & {
  dependencies?: Array<{ uid: string; reltype?: string }>;
};

const taskPreview = (task: TaskPreviewInput): string => {
  const lines: string[] = [];
  const add = (label: string, value: string | number | null | undefined): void => {
    if (value !== undefined && value !== null && value !== "") lines.push(`${label}: ${value}`);
  };
  const addList = (label: string, values: string[] | undefined): void => {
    if (values?.length) lines.push(`${label}: ${values.join(", ")}`);
  };

  add("Title", task.title === undefined ? undefined : task.exp === null || task.exp === undefined
    ? task.title
    : `[${task.exp}] ${task.title}`);
  add("Status", task.status);
  add("Priority", task.priority);
  add("Due", task.due);
  add("Scheduled", task.scheduled);
  addList("Tags", task.tags);
  addList("Contexts", task.contexts);
  addList("Projects", task.projects);
  add("Estimated time", task.timeEstimate === null || task.timeEstimate === undefined ? undefined : `${task.timeEstimate} min`);
  add("Recurrence", task.recurrence);
  if (task.dependencies?.length) {
    lines.push(`Blocked by: ${task.dependencies.map((dependency) => dependency.uid).join(", ")}`);
  }
  add("Path", task.path);
  return lines.join("\n") || "No task fields set.";
};

const presentTask = (task: BrainTask): BrainTask & { displayTitle: string } => ({
  ...task,
  displayTitle: taskDisplayTitle(task)
});

const expPreview = (exp: TaskExpState | ExpRecordInput | null): string => {
  if (!exp) return "No EXP score recorded.";
  const state = "state" in exp ? exp.state : exp.action === "award" ? "earned" : "planned";
  return [
    `EXP: ${exp.value}`,
    `State: ${state}`,
    `Confidence: ${Math.round(exp.confidence * 100)}%`,
    `Reason: ${exp.reason}`,
    `Output: ${exp.factors.output}`,
    `Difficulty: ${exp.factors.difficulty}`,
    `Rigor: ${exp.factors.rigor}`,
    `Friction: ${exp.factors.friction}`,
    `Independence: ${exp.factors.independence}`,
    `Significance: ${exp.factors.significance}`
  ].join("\n");
};

export class AgentToolRegistry {
  private readonly tools: Map<string, RegisteredTool>;

  constructor(
    private readonly vaultTools: VaultTools,
    private readonly retrievalIndex: VaultRetrievalIndex,
    private readonly skillRegistry: SkillRegistry,
    private readonly taskService: TaskService,
    private readonly expService: ExpService,
    private readonly isAutoExpScoringEnabled: () => boolean = () => false
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
          tasks: this.taskService.getStatus(),
          automaticTaskExp: this.isAutoExpScoringEnabled()
            ? "enabled for newly created non-sensitive tasks"
            : "disabled",
          installedSkills: this.skillRegistry.list(),
          capabilities: [
            "render Obsidian Markdown including tables, links, callouts, code, and math",
            "inspect, list, read, search, and retrieve permitted Markdown notes",
            "create, append, patch, replace, rename, move, trash, and update frontmatter after approval",
            "discover and load traditional SKILL.md skills",
            "query, inspect, create, update, and complete TaskNotes tasks",
            "score, award, review, and track accomplishment-first task EXP",
            "cite vault sources with clickable Obsidian wikilinks"
          ],
          limitations: [
            "no shell or unrestricted filesystem access",
            "no access to excluded paths",
            "direct sensitive note reads require approval; semantic retrieval follows the user's global semantic consent",
            "chat-requested writes require explicit approval; automatic task EXP writes occur only under the user's global opt-in"
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
            name: "query_tasks",
            description: "Query normalized tasks through TaskNotes runtime API v1, with a generic Markdown fallback. Results include clickable citations.",
            parameters: {
              type: "object",
              properties: {
                text: { type: "string", description: "Optional title or path text." },
                status: { type: "string" },
                priority: { type: "string" },
                tags: { type: "array", items: { type: "string" } },
                folder: { type: "string" },
                due_before: { type: "string", description: "Inclusive YYYY-MM-DD upper bound." },
                due_after: { type: "string", description: "Inclusive YYYY-MM-DD lower bound." },
                completed_on: {
                  type: "string",
                  description: "YYYY-MM-DD completion date. Includes TaskNotes recurring complete_instances."
                },
                include_completed: { type: "boolean", description: "Defaults to false." },
                limit: { type: "integer", minimum: 1, maximum: 200 }
              },
              additionalProperties: false
            }
          }
        },
        risk: "read",
        execute: async (input) => {
          const query: TaskQuery = {
            text: typeof input.text === "string" ? input.text : undefined,
            status: typeof input.status === "string" ? input.status : undefined,
            priority: typeof input.priority === "string" ? input.priority : undefined,
            tags: stringArrayArg(input, "tags"),
            folder: typeof input.folder === "string" ? input.folder : undefined,
            dueBefore: typeof input.due_before === "string" ? input.due_before : undefined,
            dueAfter: typeof input.due_after === "string" ? input.due_after : undefined,
            completedOn: typeof input.completed_on === "string" ? input.completed_on : undefined,
            includeCompleted: booleanArg(input, "include_completed"),
            limit: Math.min(numberArg(input, "limit", 50), 200)
          };
          const tasks = await this.taskService.list(query);
          return {
            provider: this.taskService.getStatus().active.provider,
            count: tasks.length,
            tasks: tasks.map(presentTask)
          };
        }
      },
      {
        definition: {
          type: "function",
          function: {
            name: "get_task",
            description: "Inspect one task by its vault-relative Markdown path.",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
              additionalProperties: false
            }
          }
        },
        risk: "read",
        execute: async (input, options) => {
          const path = stringArg(input, "path");
          const task = await this.taskService.get(path, options.allowSensitive);
          if (!task) throw new Error(`Task not found: ${path}`);
          return presentTask(task);
        }
      },
      {
        definition: {
          type: "function",
          function: {
            name: "get_task_exp",
            description: "Read the current accomplishment-first EXP score stored on one task.",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
              additionalProperties: false
            }
          }
        },
        risk: "read",
        execute: async (input) => {
          const path = stringArg(input, "path");
          const task = await this.taskService.get(path, true);
          if (!task) throw new Error(`Task not found: ${path}`);
          return {
            task: {
              path: task.path,
              title: task.title,
              displayTitle: taskDisplayTitle(task),
              citation: task.citation
            },
            exp: await this.expService.taskState(path)
          };
        }
      },
      {
        definition: {
          type: "function",
          function: {
            name: "get_exp_progress",
            description: "Read earned EXP totals, streaks, level progress, and recent awards from the Markdown EXP ledger.",
            parameters: { type: "object", properties: {}, additionalProperties: false }
          }
        },
        risk: "read",
        execute: async () => this.expService.progress()
      },
      {
        definition: {
          type: "function",
          function: {
            name: "review_exp_calibration",
            description: "Review recent EXP score distribution, confidence, common values, and rubric buckets for consistency.",
            parameters: {
              type: "object",
              properties: {
                days: { type: "integer", minimum: 1, maximum: 365, description: "Review window; defaults to 30 days." }
              },
              additionalProperties: false
            }
          }
        },
        risk: "read",
        execute: async (input) => this.expService.review(numberArg(input, "days", 30))
      },
      {
        definition: {
          type: "function",
          function: {
            name: "record_task_exp",
            description: "Plan, award, or recalibrate task EXP. Writes task frontmatter and an immutable Markdown ledger entry after approval.",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string", description: "Vault-relative task Markdown path." },
                action: {
                  type: "string",
                  enum: ["plan", "award", "recalibrate"],
                  description: "Plan scores upcoming work; award records completed work; recalibrate replaces the current planned score."
                },
                value: {
                  type: "integer",
                  minimum: 25,
                  maximum: 1000,
                  multipleOf: 25,
                  description: "Calibrated EXP score."
                },
                confidence: { type: "number", minimum: 0, maximum: 1 },
                reason: { type: "string", description: "Short overall scoring rationale." },
                factors: {
                  type: "object",
                  properties: {
                    output: { type: "string" },
                    difficulty: { type: "string" },
                    rigor: { type: "string" },
                    friction: { type: "string" },
                    independence: { type: "string" },
                    significance: { type: "string" }
                  },
                  required: ["output", "difficulty", "rigor", "friction", "independence", "significance"],
                  additionalProperties: false
                },
                allow_repeat: {
                  type: "boolean",
                  description: "Use only for a new recurrence or an intentional additional award on an already-awarded task."
                }
              },
              required: ["path", "action", "value", "confidence", "reason", "factors"],
              additionalProperties: false
            }
          }
        },
        risk: "high-write",
        execute: async (input) => this.expService.record(expInput(input))
      },
      {
        definition: {
          type: "function",
          function: {
            name: "create_task",
            description: "Create a task through TaskNotes, or as a generic Markdown task if TaskNotes is unavailable. Requires approval. When EXP is active, propose planned EXP unless automatic task scoring is enabled; the automatic queue handles it in that mode.",
            parameters: {
              type: "object",
              properties: {
                title: { type: "string" },
                status: { type: "string" },
                priority: { type: "string" },
                due: { type: ["string", "null"] },
                scheduled: { type: ["string", "null"] },
                tags: { type: "array", items: { type: "string" } },
                contexts: { type: "array", items: { type: "string" } },
                projects: { type: "array", items: { type: "string" } },
                time_estimate: { type: ["number", "null"], minimum: 0 },
                recurrence: { type: ["string", "null"] },
                blocked_by: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      uid: { type: "string", description: "Vault path of the blocking task." },
                      reltype: { type: "string", description: "Defaults to FINISHTOSTART." }
                    },
                    required: ["uid"],
                    additionalProperties: false
                  }
                }
              },
              required: ["title"],
              additionalProperties: false
            }
          }
        },
        risk: "high-write",
        execute: async (input) => {
          const created = await this.taskService.create({
            ...taskFields(input),
            title: stringArg(input, "title")
          } as TaskCreateInput);
          return { task: presentTask(created), verified: true };
        }
      },
      {
        definition: {
          type: "function",
          function: {
            name: "update_task",
            description: "Update selected task fields through the active task provider. Requires approval with a before/after preview.",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string" },
                updates: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    status: { type: "string" },
                    priority: { type: "string" },
                    due: { type: ["string", "null"] },
                    scheduled: { type: ["string", "null"] },
                    tags: { type: "array", items: { type: "string" } },
                    contexts: { type: "array", items: { type: "string" } },
                    projects: { type: "array", items: { type: "string" } },
                    time_estimate: { type: ["number", "null"], minimum: 0 },
                    recurrence: { type: ["string", "null"] },
                    blocked_by: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          uid: { type: "string" },
                          reltype: { type: "string" }
                        },
                        required: ["uid"],
                        additionalProperties: false
                      }
                    }
                  },
                  additionalProperties: false
                }
              },
              required: ["path", "updates"],
              additionalProperties: false
            }
          }
        },
        risk: "high-write",
        execute: async (input) => {
          const path = stringArg(input, "path");
          const updates = taskFields(objectInput(input.updates));
          if (Object.keys(updates).length === 0) throw new Error("No task fields were provided.");
          return { task: presentTask(await this.taskService.update(path, updates)), verified: true };
        }
      },
      {
        definition: {
          type: "function",
          function: {
            name: "complete_task",
            description: "Mark a task complete using TaskNotes's configured completion behavior. Requires approval.",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
              additionalProperties: false
            }
          }
        },
        risk: "high-write",
        execute: async (input) => ({
          task: presentTask(await this.taskService.complete(stringArg(input, "path"))),
          verified: true
        })
      },
      {
        definition: {
          type: "function",
          function: {
            name: "add_task_dependency",
            description: "Add a blocking dependency to a task. Requires approval.",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string", description: "Task being blocked." },
                dependency_path: { type: "string", description: "Task that must be completed first." },
                relationship: { type: "string", description: "Defaults to FINISHTOSTART." }
              },
              required: ["path", "dependency_path"],
              additionalProperties: false
            }
          }
        },
        risk: "high-write",
        execute: async (input) => ({
          task: presentTask(await this.taskService.addDependency(stringArg(input, "path"), {
            uid: stringArg(input, "dependency_path"),
            ...(typeof input.relationship === "string" ? { reltype: input.relationship } : {})
          })),
          verified: true
        })
      },
      {
        definition: {
          type: "function",
          function: {
            name: "remove_task_dependency",
            description: "Remove a blocking dependency from a task. Requires approval.",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string" },
                dependency_path: { type: "string" }
              },
              required: ["path", "dependency_path"],
              additionalProperties: false
            }
          }
        },
        risk: "high-write",
        execute: async (input) => ({
          task: presentTask(await this.taskService.removeDependency(
            stringArg(input, "path"),
            stringArg(input, "dependency_path")
          )),
          verified: true
        })
      },
      {
        definition: {
          type: "function",
          function: {
            name: "start_task_timer",
            description: "Start TaskNotes time tracking for a task as a secondary effort metric. Requires approval.",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string" },
                description: { type: "string" }
              },
              required: ["path"],
              additionalProperties: false
            }
          }
        },
        risk: "low-write",
        execute: async (input) => ({
          task: presentTask(await this.taskService.startTimer(
            stringArg(input, "path"),
            typeof input.description === "string" ? input.description : undefined
          )),
          verified: true
        })
      },
      {
        definition: {
          type: "function",
          function: {
            name: "stop_task_timer",
            description: "Stop the active TaskNotes time entry for a task. Requires approval.",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
              additionalProperties: false
            }
          }
        },
        risk: "low-write",
        execute: async (input) => ({
          task: presentTask(await this.taskService.stopTimer(stringArg(input, "path"))),
          verified: true
        })
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
    } else if (call.function.name === "get_task" || call.function.name === "get_task_exp") {
      const report = await this.taskService.inspectSensitivity(stringArg(input, "path"));
      sensitive = report.sensitive;
      sensitivityReasons = report.reasons;
    } else if (call.function.name === "create_task") {
      preview = {
        title: `Create task: ${stringArg(input, "title")}`,
        before: "Task does not exist yet.",
        after: taskPreview({ ...taskFields(input), title: stringArg(input, "title") }),
        details: `Provider: ${this.taskService.getStatus().active.provider}`
      };
    } else if (call.function.name === "update_task") {
      const path = stringArg(input, "path");
      const before = await this.taskService.get(path, true);
      if (!before) throw new Error(`Task not found: ${path}`);
      ({ sensitive, reasons: sensitivityReasons } = await this.taskService.inspectSensitivity(path));
      const updates = taskFields(objectInput(input.updates));
      preview = {
        title: `Update task: ${before.title}`,
        before: taskPreview(before),
        after: taskPreview({ ...before, ...updates }),
        details: before.citation
      };
    } else if (call.function.name === "complete_task") {
      const path = stringArg(input, "path");
      const before = await this.taskService.get(path, true);
      if (!before) throw new Error(`Task not found: ${path}`);
      ({ sensitive, reasons: sensitivityReasons } = await this.taskService.inspectSensitivity(path));
      preview = {
        title: `Complete task: ${before.title}`,
        before: taskPreview(before),
        after: "TaskNotes will apply its configured completion status and recurrence behavior.",
        details: before.citation
      };
    } else if (call.function.name === "add_task_dependency" || call.function.name === "remove_task_dependency") {
      const path = stringArg(input, "path");
      const before = await this.taskService.get(path, true);
      if (!before) throw new Error(`Task not found: ${path}`);
      ({ sensitive, reasons: sensitivityReasons } = await this.taskService.inspectSensitivity(path));
      if (call.function.name === "add_task_dependency") {
        const dependencyReport = await this.taskService.inspectSensitivity(stringArg(input, "dependency_path"));
        sensitive ||= dependencyReport.sensitive;
        sensitivityReasons.push(...dependencyReport.reasons);
      }
      const dependencyPath = stringArg(input, "dependency_path");
      const dependencies = call.function.name === "add_task_dependency"
        ? [...before.dependencies, {
            uid: dependencyPath,
            reltype: typeof input.relationship === "string" ? input.relationship : "FINISHTOSTART"
          }]
        : before.dependencies.filter((dependency) => dependency.uid !== dependencyPath);
      preview = {
        title: `${call.function.name === "add_task_dependency" ? "Add" : "Remove"} task dependency`,
        before: before.dependencies.length ? before.dependencies.map((dependency) => dependency.uid).join("\n") : "No task dependencies.",
        after: dependencies.length ? dependencies.map((dependency) => dependency.uid).join("\n") : "No task dependencies.",
        details: before.citation
      };
    } else if (call.function.name === "start_task_timer" || call.function.name === "stop_task_timer") {
      const path = stringArg(input, "path");
      const before = await this.taskService.get(path, true);
      if (!before) throw new Error(`Task not found: ${path}`);
      ({ sensitive, reasons: sensitivityReasons } = await this.taskService.inspectSensitivity(path));
      const starting = call.function.name === "start_task_timer";
      preview = {
        title: `${starting ? "Start" : "Stop"} task timer: ${before.title}`,
        before: before.timeTrackingActive ? "timer active" : "timer stopped",
        after: starting ? "timer active" : "timer stopped",
        details: before.citation
      };
    } else if (call.function.name === "record_task_exp") {
      const next = this.expService.validate(expInput(input));
      const task = await this.taskService.get(next.path, true);
      if (!task) throw new Error(`Task not found: ${next.path}`);
      const report = await this.taskService.inspectSensitivity(next.path);
      sensitive = report.sensitive;
      sensitivityReasons = report.reasons;
      preview = {
        title: `${next.action === "award" ? "Award" : next.action === "recalibrate" ? "Recalibrate" : "Plan"} EXP: ${task.title}`,
        before: expPreview(await this.expService.taskState(next.path)),
        after: expPreview(next),
        details: `${task.citation}\nTitle → ${taskDisplayTitle({ ...task, exp: next.value })}\nImmutable Markdown ledger entry · time fields remain unchanged`
      };
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
