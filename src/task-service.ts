import type {
  BrainTask,
  TaskCreateInput,
  TaskPatch,
  TaskProvider,
  TaskProviderStatus,
  TaskQuery
} from "./task-provider";

export class TaskService {
  constructor(
    private readonly taskNotes: TaskProvider,
    private readonly markdown: TaskProvider,
    private readonly getExcludedPaths: () => string[] = () => [],
    private readonly getSensitiveTags: () => string[] = () => []
  ) {}

  getStatus(): {
    active: TaskProviderStatus;
    tasknotes: TaskProviderStatus;
    fallback: TaskProviderStatus;
  } {
    const tasknotes = this.taskNotes.status();
    const fallback = this.markdown.status();
    return {
      active: tasknotes.available ? tasknotes : fallback,
      tasknotes,
      fallback
    };
  }

  list(query?: TaskQuery): Promise<BrainTask[]> {
    return this.active().list(query).then((tasks) => tasks.filter((task) =>
      !this.isExcluded(task.path) && !this.isSensitive(task)
    ));
  }

  async get(path: string, allowSensitive = false): Promise<BrainTask | null> {
    this.requireAllowedPath(path);
    const task = await this.active().get(path);
    if (task && this.isSensitive(task) && !allowSensitive) {
      throw new Error(`Sensitive task approval required: ${task.tags.join(", ")}`);
    }
    return task;
  }

  create(input: TaskCreateInput): Promise<BrainTask> {
    return this.active().create(input);
  }

  update(path: string, patch: TaskPatch): Promise<BrainTask> {
    this.requireAllowedPath(path);
    return this.active().update(path, patch);
  }

  complete(path: string): Promise<BrainTask> {
    this.requireAllowedPath(path);
    return this.active().complete(path);
  }

  addDependency(path: string, dependency: { uid: string; reltype?: string }): Promise<BrainTask> {
    this.requireAllowedPath(path);
    this.requireAllowedPath(dependency.uid);
    return this.active().addDependency(path, dependency);
  }

  removeDependency(path: string, uid: string): Promise<BrainTask> {
    this.requireAllowedPath(path);
    return this.active().removeDependency(path, uid);
  }

  startTimer(path: string, description?: string): Promise<BrainTask> {
    this.requireAllowedPath(path);
    return this.active().startTimer(path, description);
  }

  stopTimer(path: string): Promise<BrainTask> {
    this.requireAllowedPath(path);
    return this.active().stopTimer(path);
  }

  async inspectSensitivity(path: string): Promise<{ sensitive: boolean; reasons: string[] }> {
    this.requireAllowedPath(path);
    const task = await this.active().get(path);
    if (!task) throw new Error(`Task not found: ${path}`);
    const configured = new Set(this.getSensitiveTags().map((tag) => tag.replace(/^#/, "").toLocaleLowerCase()));
    const matching = task.tags
      .map((tag) => tag.replace(/^#/, ""))
      .filter((tag) => configured.has(tag.toLocaleLowerCase()));
    return { sensitive: matching.length > 0, reasons: matching.map((tag) => `#${tag}`) };
  }

  private active(): TaskProvider {
    return this.taskNotes.status().available ? this.taskNotes : this.markdown;
  }

  private isSensitive(task: BrainTask): boolean {
    const configured = new Set(this.getSensitiveTags().map((tag) => tag.replace(/^#/, "").toLocaleLowerCase()));
    return task.tags.some((tag) => configured.has(tag.replace(/^#/, "").toLocaleLowerCase()));
  }

  private isExcluded(path: string): boolean {
    const normalized = path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    return this.getExcludedPaths().some((candidate) => {
      const excluded = candidate.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
      return Boolean(excluded) && (normalized === excluded || normalized.startsWith(`${excluded}/`));
    });
  }

  private requireAllowedPath(path: string): void {
    if (this.isExcluded(path)) throw new Error(`The task path is excluded from agent access: ${path}`);
  }
}
