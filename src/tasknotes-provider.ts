import type { App } from "obsidian";
import {
  citationForTask,
  completedTaskStatus,
  filterTasks,
  type BrainTask,
  type TaskCreateInput,
  type TaskPatch,
  type TaskProvider,
  type TaskProviderStatus,
  type TaskQuery
} from "./task-provider";

type UnknownRecord = Record<string, unknown>;

interface TaskNotesRuntimeApi {
  apiVersion: number;
  hasCapability?: (capability: string) => boolean;
  lifecycle?: { ready?: () => Promise<void> };
  tasks: {
    get: (path: string) => Promise<unknown> | unknown;
    list: (query?: unknown) => Promise<unknown> | unknown;
    create: (input: UnknownRecord, context?: UnknownRecord) => Promise<unknown>;
    update: (path: string, patch: UnknownRecord, context?: UnknownRecord) => Promise<unknown>;
    complete: (path: string, options?: UnknownRecord, context?: UnknownRecord) => Promise<unknown>;
    addDependency: (path: string, dependency: UnknownRecord, context?: UnknownRecord) => Promise<unknown>;
    removeDependency: (path: string, uid: string, context?: UnknownRecord) => Promise<unknown>;
  };
  time: {
    start: (path: string, options?: UnknownRecord, context?: UnknownRecord) => Promise<unknown>;
    stop: (path: string, context?: UnknownRecord) => Promise<unknown>;
  };
}

interface AppWithPlugins extends App {
  plugins?: {
    plugins?: Record<string, { api?: TaskNotesRuntimeApi }>;
    getPlugin?: (id: string) => { api?: TaskNotesRuntimeApi } | null;
  };
}

const record = (value: unknown): UnknownRecord =>
  value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};

const optionalString = (value: unknown): string | null => {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "string" ? value : String(value);
};

const stringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.map((item) => typeof item === "string" ? item : String(item)).filter(Boolean);
};

const dependencies = (value: unknown): Array<{ uid: string; reltype: string }> =>
  Array.isArray(value) ? value.flatMap((entry) => {
    const dependency = record(entry);
    const uid = optionalString(dependency.uid);
    if (!uid) return [];
    return [{ uid, reltype: optionalString(dependency.reltype) ?? "FINISHTOSTART" }];
  }) : [];

const compactRecord = (value: UnknownRecord): UnknownRecord =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));

export class TaskNotesProvider implements TaskProvider {
  constructor(private readonly app: App) {}

  status(): TaskProviderStatus {
    const api = this.api();
    if (!api) {
      return {
        provider: "tasknotes",
        available: false,
        reason: "TaskNotes runtime API is not available."
      };
    }
    if (api.apiVersion !== 1) {
      return {
        provider: "tasknotes",
        available: false,
        apiVersion: api.apiVersion,
        reason: `TaskNotes API v${api.apiVersion} is unsupported; Brain requires v1.`
      };
    }
    if (api.hasCapability && !api.hasCapability("tasks.read")) {
      return {
        provider: "tasknotes",
        available: false,
        apiVersion: api.apiVersion,
        reason: "TaskNotes does not expose the tasks.read capability."
      };
    }
    return {
      provider: "tasknotes",
      available: true,
      apiVersion: api.apiVersion,
      reason: "TaskNotes runtime API v1 is active."
    };
  }

  async list(query: TaskQuery = {}): Promise<BrainTask[]> {
    const api = await this.ready(false);
    const response = await api.tasks.list();
    const rows = Array.isArray(response)
      ? response
      : Array.isArray(record(response).tasks) ? record(response).tasks as unknown[] : [];
    return filterTasks(rows.map((task) => this.normalize(task)), query);
  }

  async get(path: string): Promise<BrainTask | null> {
    const task = await (await this.ready(false)).tasks.get(path);
    return task ? this.normalize(task) : null;
  }

  async create(input: TaskCreateInput): Promise<BrainTask> {
    const api = await this.ready(true);
    const created = await api.tasks.create(compactRecord({
      title: input.title,
      status: input.status,
      priority: input.priority,
      due: input.due,
      scheduled: input.scheduled,
      tags: input.tags,
      contexts: input.contexts,
      projects: input.projects,
      timeEstimate: input.timeEstimate,
      recurrence: input.recurrence,
      blockedBy: input.dependencies
    }), this.context("create task"));
    const normalized = this.normalize(created);
    return await this.get(normalized.path) ?? normalized;
  }

  async update(path: string, patch: TaskPatch): Promise<BrainTask> {
    const api = await this.ready(true);
    const { dependencies: blockedBy, ...fields } = patch;
    const updated = await api.tasks.update(
      path,
      compactRecord({ ...fields, ...(blockedBy !== undefined ? { blockedBy } : {}) }),
      this.context("update task")
    );
    const verified = await this.get(path);
    if (verified) return verified;
    if (updated) return this.normalize(updated);
    throw new Error(`TaskNotes updated the task but it could not be verified: ${path}`);
  }

  async complete(path: string): Promise<BrainTask> {
    const api = await this.ready(true);
    const completed = await api.tasks.complete(path, undefined, this.context("complete task"));
    const verified = await this.get(path);
    if (verified) return verified;
    if (completed) return this.normalize(completed);
    throw new Error(`TaskNotes completed the task but it could not be verified: ${path}`);
  }

  async addDependency(path: string, dependency: { uid: string; reltype?: string }): Promise<BrainTask> {
    const api = await this.ready(true);
    await api.tasks.addDependency(path, {
      uid: dependency.uid,
      reltype: dependency.reltype ?? "FINISHTOSTART"
    }, this.context("add task dependency"));
    return await this.get(path) ?? (() => { throw new Error(`Task dependency could not be verified: ${path}`); })();
  }

  async removeDependency(path: string, uid: string): Promise<BrainTask> {
    const api = await this.ready(true);
    await api.tasks.removeDependency(path, uid, this.context("remove task dependency"));
    return await this.get(path) ?? (() => { throw new Error(`Task dependency removal could not be verified: ${path}`); })();
  }

  async startTimer(path: string, description?: string): Promise<BrainTask> {
    const api = await this.ready(true, "time.write");
    const updated = await api.time.start(
      path,
      description ? { description } : undefined,
      this.context("start task timer")
    );
    return await this.get(path) ?? this.normalize(updated);
  }

  async stopTimer(path: string): Promise<BrainTask> {
    const api = await this.ready(true, "time.write");
    const updated = await api.time.stop(path, this.context("stop task timer"));
    return await this.get(path) ?? this.normalize(updated);
  }

  private api(): TaskNotesRuntimeApi | null {
    const plugins = (this.app as AppWithPlugins).plugins;
    return plugins?.getPlugin?.("tasknotes")?.api
      ?? plugins?.plugins?.tasknotes?.api
      ?? null;
  }

  private async ready(write: boolean, capability = write ? "tasks.write" : "tasks.read"): Promise<TaskNotesRuntimeApi> {
    const status = this.status();
    const api = this.api();
    if (!status.available || !api) throw new Error(status.reason);
    if (api.hasCapability && !api.hasCapability(capability)) {
      throw new Error(`TaskNotes does not expose the ${capability} capability.`);
    }
    await api.lifecycle?.ready?.();
    return api;
  }

  private context(reason: string): UnknownRecord {
    return {
      source: "obsidian-brain",
      correlationId: typeof crypto?.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      reason
    };
  }

  private normalize(value: unknown): BrainTask {
    const task = record(value);
    const file = record(task.file);
    const path = optionalString(task.path) ?? optionalString(task.filePath) ?? optionalString(file.path);
    if (!path) throw new Error("TaskNotes returned a task without a vault path.");
    const status = optionalString(task.status) ?? "open";
    const title = optionalString(task.title)
      ?? path.split("/").at(-1)?.replace(/\.md$/i, "")
      ?? "Untitled task";
    const timeEstimate = typeof task.timeEstimate === "number" && Number.isFinite(task.timeEstimate)
      ? task.timeEstimate
      : null;
    const frontmatter = this.app.metadataCache.getCache(path)?.frontmatter ?? {};
    const rawExp = typeof task.exp === "number" ? task.exp : frontmatter.exp;
    const exp = typeof rawExp === "number" && Number.isFinite(rawExp) ? rawExp : null;
    const rawExpState = optionalString(task.expState) ?? optionalString(task.exp_state) ?? optionalString(frontmatter.exp_state);
    const timeEntries = Array.isArray(task.timeEntries) ? task.timeEntries.map(record) : [];
    return {
      path,
      title,
      status,
      priority: optionalString(task.priority),
      due: optionalString(task.due),
      scheduled: optionalString(task.scheduled),
      tags: stringArray(task.tags),
      contexts: stringArray(task.contexts),
      projects: stringArray(task.projects),
      timeEstimate,
      exp,
      expState: rawExpState === "earned" ? "earned" : rawExpState === "planned" ? "planned" : null,
      recurrence: optionalString(task.recurrence),
      dependencies: dependencies(task.blockedBy),
      timeTrackingActive: timeEntries.some((entry) => !entry.endTime),
      completed: task.completed === true || completedTaskStatus(status),
      provider: "tasknotes",
      citation: citationForTask(path)
    };
  }
}
