import type {
  BrainTask,
  TaskCreateInput,
  TaskPatch,
  TaskProvider,
  TaskProviderStatus,
  TaskQuery
} from "./task-provider";
import type { SensitiveContentGuard } from "./sensitive-content";

export class TaskService {
  constructor(
    private readonly taskNotes: TaskProvider,
    private readonly markdown: TaskProvider,
    private readonly getExcludedPaths: () => string[] = () => [],
    private readonly sensitiveGuard?: SensitiveContentGuard
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

  async list(query?: TaskQuery): Promise<BrainTask[]> {
    const tasks = (await this.active().list(query)).filter((task) => !this.isExcluded(task.path));
    const sensitivity = await Promise.all(tasks.map(async (task) => {
      try {
        return (await this.inspectSensitivity(task.path)).sensitive;
      } catch {
        // Fail closed when a task cannot be inspected reliably.
        return true;
      }
    }));
    return tasks.filter((_, index) => !sensitivity[index]);
  }

  async get(path: string, allowSensitive = false): Promise<BrainTask | null> {
    this.requireAllowedPath(path);
    const task = await this.active().get(path);
    if (task && !allowSensitive) {
      const report = await this.inspectSensitivity(path);
      if (report.sensitive) {
        throw new Error(`Sensitive task approval required: ${report.reasons.join("; ")}`);
      }
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
    return this.sensitiveGuard?.inspectPath(path) ?? { sensitive: false, reasons: [] };
  }

  private active(): TaskProvider {
    return this.taskNotes.status().available ? this.taskNotes : this.markdown;
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
