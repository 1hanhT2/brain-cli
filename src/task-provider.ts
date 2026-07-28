export type TaskProviderKind = "tasknotes" | "markdown";

export interface BrainTask {
  path: string;
  title: string;
  status: string;
  priority: string | null;
  due: string | null;
  scheduled: string | null;
  tags: string[];
  contexts: string[];
  projects: string[];
  timeEstimate: number | null;
  recurrence: string | null;
  dependencies: Array<{ uid: string; reltype: string }>;
  timeTrackingActive: boolean;
  completed: boolean;
  provider: TaskProviderKind;
  citation: string;
}

export interface TaskQuery {
  text?: string;
  status?: string;
  priority?: string;
  tags?: string[];
  folder?: string;
  dueBefore?: string;
  dueAfter?: string;
  includeCompleted?: boolean;
  limit?: number;
}

export interface TaskCreateInput {
  title: string;
  status?: string;
  priority?: string;
  due?: string | null;
  scheduled?: string | null;
  tags?: string[];
  contexts?: string[];
  projects?: string[];
  timeEstimate?: number | null;
  recurrence?: string | null;
  dependencies?: Array<{ uid: string; reltype?: string }>;
}

export type TaskPatch = Partial<Omit<TaskCreateInput, "title">> & { title?: string };

export interface TaskProviderStatus {
  provider: TaskProviderKind;
  available: boolean;
  apiVersion?: number;
  reason: string;
}

export interface TaskProvider {
  status(): TaskProviderStatus;
  list(query?: TaskQuery): Promise<BrainTask[]>;
  get(path: string): Promise<BrainTask | null>;
  create(input: TaskCreateInput): Promise<BrainTask>;
  update(path: string, patch: TaskPatch): Promise<BrainTask>;
  complete(path: string): Promise<BrainTask>;
  addDependency(path: string, dependency: { uid: string; reltype?: string }): Promise<BrainTask>;
  removeDependency(path: string, uid: string): Promise<BrainTask>;
  startTimer(path: string, description?: string): Promise<BrainTask>;
  stopTimer(path: string): Promise<BrainTask>;
}

export const citationForTask = (path: string): string => `[[${path.replace(/\.md$/, "")}]]`;

export const completedTaskStatus = (status: string): boolean =>
  ["done", "completed", "complete", "cancelled", "canceled"].includes(status.trim().toLocaleLowerCase());

export const filterTasks = (tasks: BrainTask[], query: TaskQuery = {}): BrainTask[] => {
  const text = query.text?.trim().toLocaleLowerCase() ?? "";
  const status = query.status?.trim().toLocaleLowerCase() ?? "";
  const priority = query.priority?.trim().toLocaleLowerCase() ?? "";
  const folder = query.folder?.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") ?? "";
  const tags = new Set((query.tags ?? []).map((tag) => tag.replace(/^#/, "").toLocaleLowerCase()));
  const limit = Math.min(Math.max(Math.floor(query.limit ?? 50), 1), 200);
  return tasks
    .filter((task) => query.includeCompleted || !task.completed)
    .filter((task) => !text || `${task.title} ${task.path}`.toLocaleLowerCase().includes(text))
    .filter((task) => !status || task.status.toLocaleLowerCase() === status)
    .filter((task) => !priority || task.priority?.toLocaleLowerCase() === priority)
    .filter((task) => !folder || task.path === folder || task.path.startsWith(`${folder}/`))
    .filter((task) => tags.size === 0 || [...tags].every((tag) =>
      task.tags.some((candidate) => candidate.replace(/^#/, "").toLocaleLowerCase() === tag)
    ))
    .filter((task) => !query.dueBefore || Boolean(task.due && task.due <= query.dueBefore))
    .filter((task) => !query.dueAfter || Boolean(task.due && task.due >= query.dueAfter))
    .sort((left, right) =>
      (left.due ?? "9999").localeCompare(right.due ?? "9999")
      || left.title.localeCompare(right.title)
    )
    .slice(0, limit);
};
