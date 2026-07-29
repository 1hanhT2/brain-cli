import type { ToolDefinition, ToolCall } from "./openrouter";
import type { ToolRisk } from "./types";
import type { VaultTools } from "./vault-tools";
import type { VaultRetrievalIndex } from "./retrieval-index";
import type { SkillRegistry } from "./skill-registry";
import type { TaskService } from "./task-service";
import {
  formatExpTaskTitle,
  taskDisplayTitle,
  type BrainTask,
  type TaskCreateInput,
  type TaskPatch,
  type TaskQuery
} from "./task-provider";
import type { ExpService } from "./exp-service";
import type { MemoryService } from "./memory-service";
import type { WritingCoachService } from "./writing-coach";
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
  beforeLabel?: string;
  afterLabel?: string;
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

const recordValue = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const writingCoachInputInterval = (input: Record<string, unknown>): string => {
  const minimum = numberArg(input, "interval_min_minutes", numberArg(input, "interval_minutes", 10));
  const maximum = numberArg(input, "interval_max_minutes", minimum);
  return minimum === maximum
    ? `${minimum} minutes`
    : `${minimum}–${maximum} minutes, randomized after each check`;
};

const writingCoachSessionInterval = (session: Record<string, unknown>): string => {
  const minimum = typeof session.intervalMinutes === "number" ? session.intervalMinutes : 10;
  const maximum = typeof session.intervalMaxMinutes === "number" ? session.intervalMaxMinutes : minimum;
  return minimum === maximum ? `${minimum} minutes` : `${minimum}–${maximum} minutes`;
};

const TOOL_LABELS: Record<string, string> = {
  query_tasks: "Find tasks",
  get_task: "Inspect task",
  get_task_exp: "Inspect task EXP",
  get_exp_progress: "Review EXP progress",
  review_exp_calibration: "Review EXP calibration",
  get_exp_analytics: "Review EXP analytics",
  create_exp_goal: "Create EXP goal",
  search_memory: "Search memory",
  record_memory: "Save memory",
  update_memory_status: "Update memory",
  get_writing_coach: "Inspect writing coach",
  start_writing_coach: "Start writing coach",
  check_writing_coach: "Check writing now",
  stop_writing_coach: "Stop writing coach",
  record_task_exp: "Record task EXP",
  create_task: "Create task",
  update_task: "Update task",
  complete_task: "Complete task",
  add_task_dependency: "Add task dependency",
  remove_task_dependency: "Remove task dependency",
  start_task_timer: "Start task timer",
  stop_task_timer: "Stop task timer"
};

const TASK_RESULT_LABELS: Record<string, string> = {
  create_task: "Task created",
  update_task: "Task updated",
  complete_task: "Task completed",
  add_task_dependency: "Task dependency added",
  remove_task_dependency: "Task dependency removed",
  start_task_timer: "Task timer started",
  stop_task_timer: "Task timer stopped"
};

const toolLabel = (name: string): string =>
  TOOL_LABELS[name] ?? name.replace(/_/g, " ").replace(/^\w/, (character) => character.toLocaleUpperCase());

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
    : formatExpTaskTitle(task.title, task.exp, 200));
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

const taskQueryPreview = (input: Record<string, unknown>): string => {
  const lines: string[] = [];
  const add = (label: string, value: unknown): void => {
    if (typeof value === "string" && value.trim()) lines.push(`${label}: ${value.trim()}`);
  };
  add("Text", input.text);
  add("Status", input.status);
  add("Priority", input.priority);
  add("Folder", input.folder);
  add("Due on or before", input.due_before);
  add("Due on or after", input.due_after);
  add("Completed on", input.completed_on);
  const tags = Array.isArray(input.tags) ? input.tags.filter((tag) => typeof tag === "string") : [];
  if (tags.length) lines.push(`Tags: ${tags.join(", ")}`);
  lines.push(`Completed tasks: ${input.include_completed === true ? "included" : "hidden"}`);
  lines.push(`Maximum results: ${Math.min(numberArg(input, "limit", 50), 200)}`);
  return lines.join("\n");
};

const taskListPreview = (tasks: unknown[]): string => {
  if (tasks.length === 0) return "No matching tasks.";
  return tasks.map((value) => {
    const task = recordValue(value);
    const title = typeof task.displayTitle === "string"
      ? task.displayTitle
      : typeof task.title === "string" ? task.title : "Untitled task";
    const status = typeof task.status === "string" ? task.status : "unknown status";
    const due = typeof task.due === "string" && task.due ? ` · due ${task.due}` : "";
    return `• ${title} — ${status}${due}`;
  }).join("\n");
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
    private readonly memoryService: MemoryService,
    private readonly writingCoach: WritingCoachService,
    private readonly isAutoExpScoringEnabled: () => boolean = () => false,
    private readonly getInteractiveModel: () => string = () => "",
    private readonly getCompletionExpSettings: () => {
      enabled: boolean;
      automaticAwards: boolean;
      automaticScoring: boolean;
    } = () => ({ enabled: false, automaticAwards: false, automaticScoring: false })
  ) {
    const registered: RegisteredTool[] = [
      {
        definition: {
          type: "function",
          function: {
            name: "get_writing_coach",
            description: "Inspect the current continual-writing-coach session, target file, goals, interval, and last pillar.",
            parameters: { type: "object", properties: {}, additionalProperties: false }
          }
        },
        risk: "read",
        execute: async () => ({ session: this.writingCoach.status() })
      },
      {
        definition: {
          type: "function",
          function: {
            name: "start_writing_coach",
            description: "Start persistent interval coaching for one Obsidian Markdown draft. Automatic checks use the configured background OpenRouter model and require approval.",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string", description: "Vault-relative Markdown draft path." },
                goals: { type: "string", description: "Purpose, audience, deliverable, and writing priorities." },
                interval_minutes: { type: "integer", minimum: 1, maximum: 120, description: "Fixed interval. Defaults to 10 when no range is supplied." },
                interval_min_minutes: { type: "integer", minimum: 1, maximum: 120, description: "Minimum delay for a randomized interval range." },
                interval_max_minutes: { type: "integer", minimum: 1, maximum: 120, description: "Maximum delay for a randomized interval range." }
              },
              required: ["path", "goals"],
              additionalProperties: false
            }
          }
        },
        risk: "high-write",
        execute: async (input) => ({
          session: await this.writingCoach.start(
            stringArg(input, "path"),
            stringArg(input, "goals"),
            numberArg(input, "interval_min_minutes", numberArg(input, "interval_minutes", 10)),
            numberArg(
              input,
              "interval_max_minutes",
              numberArg(input, "interval_min_minutes", numberArg(input, "interval_minutes", 10))
            )
          ),
          verified: true
        })
      },
      {
        definition: {
          type: "function",
          function: {
            name: "check_writing_coach",
            description: "Run one immediate, single-pillar writing-coach check and log its feedback. Requires approval because it calls OpenRouter.",
            parameters: { type: "object", properties: {}, additionalProperties: false }
          }
        },
        risk: "low-write",
        execute: async () => ({ ...await this.writingCoach.checkNow(), verified: true })
      },
      {
        definition: {
          type: "function",
          function: {
            name: "stop_writing_coach",
            description: "Stop the active continual-writing-coach session while retaining its Markdown feedback log.",
            parameters: { type: "object", properties: {}, additionalProperties: false }
          }
        },
        risk: "low-write",
        execute: async () => ({ session: await this.writingCoach.stop(), verified: true })
      },
      {
        definition: {
          type: "function",
          function: {
            name: "search_memory",
            description: "Search durable Brain memory fragments relevant to the current request. Review-sensitive memories are excluded.",
            parameters: {
              type: "object",
              properties: {
                query: { type: "string" },
                limit: { type: "integer", minimum: 1, maximum: 10 }
              },
              required: ["query"],
              additionalProperties: false
            }
          }
        },
        risk: "read",
        execute: async (input) => ({
          memories: await this.memoryService.search(stringArg(input, "query"), numberArg(input, "limit", 5))
        })
      },
      {
        definition: {
          type: "function",
          function: {
            name: "record_memory",
            description: "Propose a durable memory fragment from user-confirmed preferences, habits, goals, abilities, or workflows. Requires approval; use sensitivity review when it should not be retrieved automatically.",
            parameters: {
              type: "object",
              properties: {
                category: { type: "string", enum: ["ability", "habit", "preference", "goal", "workflow", "other"] },
                content: { type: "string", description: "One concise, durable fact. Never infer sensitive personal data." },
                confidence: { type: "number", minimum: 0, maximum: 1 },
                sensitivity: { type: "string", enum: ["low", "review"] }
              },
              required: ["category", "content", "confidence"],
              additionalProperties: false
            }
          }
        },
        risk: "low-write",
        execute: async (input) => ({
          memory: await this.memoryService.create({
            category: stringArg(input, "category") as import("./types").MemoryFragment["category"],
            content: stringArg(input, "content"),
            confidence: numberArg(input, "confidence", Number.NaN),
            sensitivity: input.sensitivity === "review" ? "review" : "low",
            source: "approved agent proposal"
          }),
          verified: true
        })
      },
      {
        definition: {
          type: "function",
          function: {
            name: "update_memory_status",
            description: "Revoke or supersede a durable memory fragment. Requires approval and never deletes its audit trail.",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string" },
                status: { type: "string", enum: ["superseded", "revoked"] }
              },
              required: ["path", "status"],
              additionalProperties: false
            }
          }
        },
        risk: "high-write",
        execute: async (input) => ({
          memory: await this.memoryService.setStatus(
            stringArg(input, "path"),
            stringArg(input, "status") as "superseded" | "revoked"
          ),
          verified: true
        })
      },
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
          completionTaskExp: this.getCompletionExpSettings(),
          installedSkills: this.skillRegistry.list(),
          capabilities: [
            "render Obsidian Markdown including tables, links, callouts, code, and math",
            "inspect, list, read, search, and retrieve permitted Markdown notes",
            "create, append, patch, replace, rename, move, trash, and update frontmatter after approval",
            "discover and load traditional SKILL.md skills",
            "search and propose approval-gated durable memory fragments",
            "run opt-in continual writing coaching on one changing Markdown draft",
            "query, inspect, create, update, and complete TaskNotes tasks",
            "score, award, review, and track accomplishment-first task EXP",
            "analyze EXP by task tag or project and track immutable-ledger EXP goals",
            "detect and reconcile completed-task EXP when the user enables it",
            "cite vault sources with clickable Obsidian wikilinks"
          ],
          limitations: [
            "no shell or unrestricted filesystem access",
            "no access to excluded paths",
            "direct sensitive note reads require approval; semantic retrieval follows the user's global semantic consent",
            "chat-requested writes require explicit approval; automatic task EXP writes occur only under the user's global opt-in",
            "completion detection, automatic completion scoring, and automatic award writes are separately configurable",
            "continual writing checks run only after explicit session approval, while the target draft is active, and after it changes"
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
            name: "get_exp_analytics",
            description: "Analyze earned EXP by TaskNotes tags and projects over a recent window, and show active goal progress.",
            parameters: {
              type: "object",
              properties: { days: { type: "integer", minimum: 1, maximum: 365 } },
              additionalProperties: false
            }
          }
        },
        risk: "read",
        execute: async (input) => ({
          analytics: await this.expService.analytics(numberArg(input, "days", 30)),
          goals: await this.expService.goals()
        })
      },
      {
        definition: {
          type: "function",
          function: {
            name: "create_exp_goal",
            description: "Create an EXP goal backed by immutable ledger awards. Optionally filter the goal by task tags or projects. Requires approval.",
            parameters: {
              type: "object",
              properties: {
                name: { type: "string" },
                target_exp: { type: "integer", minimum: 25 },
                period: { type: "string", enum: ["daily", "weekly", "monthly", "all-time"] },
                tags: { type: "array", items: { type: "string" } },
                projects: { type: "array", items: { type: "string" } }
              },
              required: ["name", "target_exp", "period"],
              additionalProperties: false
            }
          }
        },
        risk: "low-write",
        execute: async (input) => ({
          goal: await this.expService.createGoal({
            name: stringArg(input, "name"),
            target: numberArg(input, "target_exp", Number.NaN),
            period: stringArg(input, "period") as "daily" | "weekly" | "monthly" | "all-time",
            tags: stringArrayArg(input, "tags"),
            projects: stringArrayArg(input, "projects")
          }),
          verified: true
        })
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
        execute: async (input) => this.expService.record({
          ...expInput(input),
          scoringSource: "manual-ai",
          modelId: this.getInteractiveModel() || undefined,
          provider: this.getInteractiveModel() ? "openrouter" : undefined,
          rubricVersion: 1
        })
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

  displayName(name: string): string {
    return toolLabel(name);
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
    if (call.function.name === "get_writing_coach") {
      preview = { title: "Inspect writing coach", details: "Current target, goals, interval, and feedback cycle" };
    } else if (call.function.name === "start_writing_coach") {
      const report = await this.vaultTools.inspectSensitivity(stringArg(input, "path"));
      if (report.sensitive) {
        throw new Error(`Continual automatic coaching is unavailable for sensitive notes: ${report.reasons.join("; ")}`);
      }
      preview = {
        title: "Start continual writing coach",
        before: "No new coaching session will start without approval.",
        after: [
          `Draft: ${stringArg(input, "path")}`,
          `Goals: ${stringArg(input, "goals")}`,
          `Interval: ${writingCoachInputInterval(input)}`,
          "Feedback: one randomly cycled pillar per changed-draft check",
          "Model: configured background model"
        ].join("\n"),
        beforeLabel: "Current state",
        afterLabel: "Proposed session",
        details: "Automatic interval checks may incur OpenRouter charges. Feedback is logged under Brain/Coaching."
      };
    } else if (call.function.name === "check_writing_coach") {
      preview = {
        title: "Check writing now",
        details: "Run one OpenRouter check on the next pillar and append the nudge to the coaching log."
      };
    } else if (call.function.name === "stop_writing_coach") {
      preview = {
        title: "Stop continual writing coach",
        details: "Cancel future checks and retain the existing Markdown feedback log."
      };
    } else if (call.function.name === "query_tasks") {
      preview = {
        title: "Find tasks",
        details: taskQueryPreview(input)
      };
    } else if (call.function.name === "search_memory") {
      preview = { title: "Search memory", details: `Query: ${stringArg(input, "query")}` };
    } else if (call.function.name === "record_memory") {
      preview = {
        title: "Save durable memory",
        before: "No memory fragment exists yet.",
        after: [
          `Category: ${stringArg(input, "category")}`,
          `Confidence: ${Math.round(numberArg(input, "confidence", 0) * 100)}%`,
          `Retrieval: ${input.sensitivity === "review" ? "review-only" : "eligible when relevant"}`,
          `Memory: ${stringArg(input, "content")}`
        ].join("\n"),
        beforeLabel: "Current state",
        afterLabel: "Proposed memory",
        details: "A Markdown memory fragment will be created. It can later be revoked without deleting its audit trail."
      };
    } else if (call.function.name === "update_memory_status") {
      preview = {
        title: "Update memory status",
        details: `Memory: ${stringArg(input, "path")}\nNew status: ${stringArg(input, "status")}`
      };
    } else if (call.function.name === "read_note") {
      const report = await this.vaultTools.inspectSensitivity(stringArg(input, "path"));
      sensitive = report.sensitive;
      sensitivityReasons = report.reasons;
    } else if (call.function.name === "get_task" || call.function.name === "get_task_exp") {
      const path = stringArg(input, "path");
      const report = await this.taskService.inspectSensitivity(path);
      sensitive = report.sensitive;
      sensitivityReasons = report.reasons;
      preview = {
        title: call.function.name === "get_task" ? "Inspect task" : "Inspect task EXP",
        details: `Task: ${path}`
      };
    } else if (call.function.name === "get_exp_progress") {
      preview = { title: "Review EXP progress", details: "Earned totals, levels, streaks, and recent awards" };
    } else if (call.function.name === "review_exp_calibration") {
      preview = {
        title: "Review EXP calibration",
        details: `Review window: ${Math.min(numberArg(input, "days", 30), 365)} days`
      };
    } else if (call.function.name === "get_exp_analytics") {
      preview = { title: "Review EXP analytics", details: `Review window: ${Math.min(numberArg(input, "days", 30), 365)} days` };
    } else if (call.function.name === "create_exp_goal") {
      const tags = stringArrayArg(input, "tags") ?? [];
      const projects = stringArrayArg(input, "projects") ?? [];
      preview = {
        title: `Create EXP goal: ${stringArg(input, "name")}`,
        before: "No goal exists yet.",
        after: [
          `Target: ${numberArg(input, "target_exp", 0).toLocaleString()} EXP`,
          `Period: ${stringArg(input, "period")}`,
          `Scope: ${[...tags.map((tag) => `#${tag.replace(/^#/, "")}`), ...projects].join(" · ") || "all awards"}`
        ].join("\n"),
        beforeLabel: "Current state",
        afterLabel: "Proposed goal",
        details: "Progress will be calculated from immutable earned EXP ledger events."
      };
    } else if (call.function.name === "create_task") {
      preview = {
        title: `Create task: ${stringArg(input, "title")}`,
        before: "Task does not exist yet.",
        after: taskPreview({ ...taskFields(input), title: stringArg(input, "title") }),
        beforeLabel: "Current state",
        afterLabel: "Proposed task",
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
        beforeLabel: "Current task",
        afterLabel: "Proposed task",
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
        after: before.recurrence
          ? `Mark this occurrence complete.\nRecurrence: ${before.recurrence}\nTaskNotes will schedule the next occurrence using its configured behavior.`
          : `Mark as completed: ${taskDisplayTitle(before)}\nPath: ${before.path}`,
        beforeLabel: "Current task",
        afterLabel: "Completion result",
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
        after: dependencies.length ? dependencies.map((dependency) =>
          `${dependency.uid}${dependency.reltype ? ` (${dependency.reltype})` : ""}`
        ).join("\n") : "No task dependencies.",
        beforeLabel: "Currently blocked by",
        afterLabel: "Proposed blocked by",
        details: `Task: ${taskDisplayTitle(before)}\n${before.citation}`
      };
    } else if (call.function.name === "start_task_timer" || call.function.name === "stop_task_timer") {
      const path = stringArg(input, "path");
      const before = await this.taskService.get(path, true);
      if (!before) throw new Error(`Task not found: ${path}`);
      ({ sensitive, reasons: sensitivityReasons } = await this.taskService.inspectSensitivity(path));
      const starting = call.function.name === "start_task_timer";
      preview = {
        title: `${starting ? "Start" : "Stop"} task timer: ${before.title}`,
        before: before.timeTrackingActive ? "Timer is running." : "Timer is stopped.",
        after: starting
          ? `Start tracking time${typeof input.description === "string" && input.description.trim()
            ? `: ${input.description.trim()}` : "."}`
          : "Stop the active time entry.",
        beforeLabel: "Current timer",
        afterLabel: "Proposed timer",
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
        beforeLabel: "Current EXP",
        afterLabel: "Proposed EXP",
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

  resultPreview(call: ToolCall, value: unknown): ToolPreview | undefined {
    const name = call.function.name;
    if (["get_writing_coach", "start_writing_coach", "stop_writing_coach"].includes(name)) {
      const session = recordValue(recordValue(value).session);
      const exists = Object.keys(session).length > 0;
      return {
        title: exists
          ? `Writing coach ${session.active === true ? "active" : "stopped"}`
          : "No writing-coach session",
        after: exists ? [
          `Draft: ${typeof session.targetPath === "string" ? session.targetPath : ""}`,
          `Goals: ${typeof session.goals === "string" ? session.goals : ""}`,
          `Interval: ${writingCoachSessionInterval(session)}`,
          `Next interval: ${typeof session.scheduledIntervalMinutes === "number" ? session.scheduledIntervalMinutes : 10} minutes`,
          `Checks: ${typeof session.checks === "number" ? session.checks : 0}`,
          `Last pillar: ${typeof session.lastPillar === "string" && session.lastPillar ? session.lastPillar : "none"}`
        ].join("\n") : "Start a session by supplying a draft, writing goals, and an interval.",
        afterLabel: "Session",
        details: typeof session.citation === "string" ? session.citation : undefined
      };
    }
    if (name === "check_writing_coach") {
      const result = recordValue(value);
      return {
        title: "Writing nudge ready",
        after: typeof result.feedback === "string" ? result.feedback : "Feedback was logged.",
        afterLabel: typeof result.pillar === "string" ? result.pillar : "Feedback",
        details: typeof recordValue(result.status).citation === "string"
          ? String(recordValue(result.status).citation)
          : undefined
      };
    }
    if (name === "query_tasks") {
      const result = recordValue(value);
      const tasks = Array.isArray(result.tasks) ? result.tasks : [];
      const count = typeof result.count === "number" ? result.count : tasks.length;
      return {
        title: `${count} matching task${count === 1 ? "" : "s"}`,
        after: taskListPreview(tasks),
        afterLabel: "Results",
        details: typeof result.provider === "string" ? `Provider: ${result.provider}` : undefined
      };
    }
    if (name === "search_memory") {
      const memories = Array.isArray(recordValue(value).memories) ? recordValue(value).memories as unknown[] : [];
      return {
        title: `${memories.length} matching memor${memories.length === 1 ? "y" : "ies"}`,
        after: memories.length ? memories.map((value) => {
          const memory = recordValue(value);
          return `• ${typeof memory.category === "string" ? memory.category : "memory"}: ${typeof memory.content === "string" ? memory.content : ""}`;
        }).join("\n") : "No relevant active low-risk memories.",
        afterLabel: "Results"
      };
    }
    if (name === "record_memory" || name === "update_memory_status") {
      const memory = recordValue(recordValue(value).memory);
      return {
        title: name === "record_memory" ? "Memory saved" : "Memory updated",
        after: [
          `Category: ${typeof memory.category === "string" ? memory.category : "memory"}`,
          `Status: ${typeof memory.status === "string" ? memory.status : "unknown"}`,
          `Memory: ${typeof memory.content === "string" ? memory.content : ""}`
        ].join("\n"),
        afterLabel: "Verified memory",
        details: typeof memory.citation === "string" ? memory.citation : undefined
      };
    }
    if (name === "get_task") {
      return {
        title: "Task inspected",
        after: taskPreview(recordValue(value) as TaskPreviewInput),
        afterLabel: "Task"
      };
    }
    if (name === "get_exp_analytics") {
      const result = recordValue(value);
      const analytics = recordValue(result.analytics);
      const goals = Array.isArray(result.goals) ? result.goals as unknown[] : [];
      return {
        title: "EXP analytics ready",
        after: [
          `Earned: ${typeof analytics.earned === "number" ? analytics.earned.toLocaleString() : "0"} EXP`,
          `Awards: ${typeof analytics.awards === "number" ? analytics.awards : 0}`,
          `Active goals: ${goals.length}`
        ].join("\n"),
        afterLabel: "Summary"
      };
    }
    if (name === "create_exp_goal") {
      const goal = recordValue(recordValue(value).goal);
      return {
        title: "EXP goal created",
        after: [
          `Goal: ${typeof goal.name === "string" ? goal.name : "EXP goal"}`,
          `Progress: ${typeof goal.earned === "number" ? goal.earned.toLocaleString() : 0} / ${typeof goal.target === "number" ? goal.target.toLocaleString() : 0} EXP`,
          `Period: ${typeof goal.period === "string" ? goal.period : "unknown"}`
        ].join("\n"),
        afterLabel: "Verified goal",
        details: typeof goal.citation === "string" ? goal.citation : undefined
      };
    }
    if (name === "get_task_exp") {
      const result = recordValue(value);
      const task = recordValue(result.task);
      return {
        title: "Task EXP inspected",
        after: expPreview((result.exp ?? null) as TaskExpState | null),
        afterLabel: "EXP",
        details: typeof task.citation === "string" ? task.citation : undefined
      };
    }
    if ([
      "create_task",
      "update_task",
      "complete_task",
      "add_task_dependency",
      "remove_task_dependency",
      "start_task_timer",
      "stop_task_timer"
    ].includes(name)) {
      const result = recordValue(value);
      return {
        title: TASK_RESULT_LABELS[name] ?? `${toolLabel(name)} completed`,
        after: taskPreview(recordValue(result.task) as TaskPreviewInput),
        afterLabel: "Verified task",
        details: result.verified === true ? "Verified after writing" : undefined
      };
    }
    if (name === "record_task_exp") {
      const result = recordValue(value);
      const task = recordValue(result.task);
      return {
        title: "Task EXP recorded",
        after: expPreview((result.exp ?? null) as TaskExpState | null),
        afterLabel: "Verified EXP",
        details: [
          typeof task.citation === "string" ? task.citation : "",
          result.verified === true ? "Task frontmatter and ledger entry verified" : ""
        ].filter(Boolean).join("\n") || undefined
      };
    }
    return undefined;
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
