import { normalizePath, parseYaml, TFile, type App } from "obsidian";
import { isVaultPathSafe } from "./permissions";
import type { VaultTools } from "./vault-tools";
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

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

const scalar = (value: unknown): string | null => {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "string" ? value : String(value);
};

const array = (value: unknown): string[] =>
  (Array.isArray(value) ? value : value === null || value === undefined ? [] : [value])
    .flatMap((item) => String(item).split(/[\s,]+/))
    .filter(Boolean);

export class MarkdownTaskProvider implements TaskProvider {
  constructor(
    private readonly app: App,
    private readonly vaultTools: VaultTools,
    private readonly getFolder: () => string
  ) {}

  status(): TaskProviderStatus {
    return {
      provider: "markdown",
      available: true,
      reason: `Generic Markdown fallback is active in ${this.folder() || "the vault root"}.`
    };
  }

  async list(query: TaskQuery = {}): Promise<BrainTask[]> {
    const folder = this.folder();
    const tasks: BrainTask[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (folder && file.path !== folder && !file.path.startsWith(`${folder}/`)) continue;
      const frontmatter = await this.frontmatter(file);
      if (typeof frontmatter.status !== "string") continue;
      tasks.push(this.normalize(file, frontmatter));
    }
    return filterTasks(tasks, query);
  }

  async get(path: string): Promise<BrainTask | null> {
    const normalized = normalizePath(path);
    if (!isVaultPathSafe(normalized)) throw new Error("Task path is outside the permitted vault area.");
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (!(file instanceof TFile) || file.extension !== "md") return null;
    const frontmatter = await this.frontmatter(file);
    return typeof frontmatter.status === "string" ? this.normalize(file, frontmatter) : null;
  }

  async create(input: TaskCreateInput): Promise<BrainTask> {
    const path = this.uniquePath(input.title);
    const properties: Record<string, unknown> = {
      title: input.title,
      status: input.status ?? "open",
      priority: input.priority ?? "normal",
      due: input.due,
      scheduled: input.scheduled,
      tags: input.tags,
      contexts: input.contexts,
      projects: input.projects,
      timeEstimate: input.timeEstimate,
      recurrence: input.recurrence,
      blockedBy: input.dependencies?.map((dependency) => ({
        uid: dependency.uid,
        reltype: dependency.reltype ?? "FINISHTOSTART"
      })),
      dateCreated: new Date().toISOString()
    };
    const yaml = Object.entries(properties)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join("\n");
    await this.vaultTools.createMarkdown(path, `---\n${yaml}\n---\n\n# ${input.title}\n`);
    const created = await this.get(path);
    if (!created) throw new Error(`Created task could not be verified: ${path}`);
    return created;
  }

  async update(path: string, patch: TaskPatch): Promise<BrainTask> {
    const existing = await this.requireTask(path);
    const { dependencies, ...fields } = patch;
    const updates = Object.fromEntries(
      Object.entries({
        ...fields,
        ...(dependencies !== undefined ? { blockedBy: dependencies } : {}),
        dateModified: new Date().toISOString()
      })
        .filter(([, value]) => value !== undefined)
    );
    await this.vaultTools.updateFrontmatter(existing.path, updates);
    const verified = await this.get(existing.path);
    if (!verified) throw new Error(`Updated task could not be verified: ${existing.path}`);
    return { ...verified, ...this.normalizedPatch(patch) };
  }

  async complete(path: string): Promise<BrainTask> {
    return this.update(path, { status: "done" });
  }

  async addDependency(path: string, dependency: { uid: string; reltype?: string }): Promise<BrainTask> {
    const file = this.requireFile(path);
    const frontmatter = await this.frontmatter(file);
    const current = this.dependencies(frontmatter.blockedBy);
    if (!current.some((entry) => entry.uid === dependency.uid)) {
      current.push({ uid: dependency.uid, reltype: dependency.reltype ?? "FINISHTOSTART" });
    }
    await this.vaultTools.updateFrontmatter(path, { blockedBy: current, dateModified: new Date().toISOString() });
    return { ...await this.requireTask(path), dependencies: current };
  }

  async removeDependency(path: string, uid: string): Promise<BrainTask> {
    const file = this.requireFile(path);
    const frontmatter = await this.frontmatter(file);
    const remaining = this.dependencies(frontmatter.blockedBy).filter((entry) => entry.uid !== uid);
    await this.vaultTools.updateFrontmatter(path, { blockedBy: remaining, dateModified: new Date().toISOString() });
    return { ...await this.requireTask(path), dependencies: remaining };
  }

  async startTimer(path: string, description?: string): Promise<BrainTask> {
    const file = this.requireFile(path);
    const frontmatter = await this.frontmatter(file);
    const entries = Array.isArray(frontmatter.timeEntries)
      ? frontmatter.timeEntries.map((entry) => ({ ...(entry as Record<string, unknown>) }))
      : [];
    if (entries.some((entry) => !entry.endTime)) throw new Error(`Task already has an active timer: ${path}`);
    entries.push({
      startTime: new Date().toISOString(),
      ...(description ? { description } : {})
    });
    await this.vaultTools.updateFrontmatter(path, { timeEntries: entries, dateModified: new Date().toISOString() });
    return { ...await this.requireTask(path), timeTrackingActive: true };
  }

  async stopTimer(path: string): Promise<BrainTask> {
    const file = this.requireFile(path);
    const frontmatter = await this.frontmatter(file);
    const entries = Array.isArray(frontmatter.timeEntries)
      ? frontmatter.timeEntries.map((entry) => ({ ...(entry as Record<string, unknown>) }))
      : [];
    const activeIndex = entries.findLastIndex((entry) => !entry.endTime);
    if (activeIndex < 0) throw new Error(`Task has no active timer: ${path}`);
    entries[activeIndex] = { ...entries[activeIndex], endTime: new Date().toISOString() };
    await this.vaultTools.updateFrontmatter(path, { timeEntries: entries, dateModified: new Date().toISOString() });
    return { ...await this.requireTask(path), timeTrackingActive: false };
  }

  private async requireTask(path: string): Promise<BrainTask> {
    const task = await this.get(path);
    if (!task) throw new Error(`Task not found: ${path}`);
    return task;
  }

  private async frontmatter(file: TFile): Promise<Record<string, unknown>> {
    const cached = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (cached) return cached;
    const match = (await this.app.vault.cachedRead(file)).match(FRONTMATTER_PATTERN);
    return match ? (parseYaml(match[1]) as Record<string, unknown> | null) ?? {} : {};
  }

  private normalize(file: TFile, frontmatter: Record<string, unknown>): BrainTask {
    const status = scalar(frontmatter.status) ?? "open";
    return {
      path: file.path,
      title: scalar(frontmatter.title) ?? file.basename,
      status,
      priority: scalar(frontmatter.priority),
      due: scalar(frontmatter.due),
      scheduled: scalar(frontmatter.scheduled),
      tags: array(frontmatter.tags),
      contexts: array(frontmatter.contexts),
      projects: array(frontmatter.projects),
      timeEstimate: typeof frontmatter.timeEstimate === "number" ? frontmatter.timeEstimate : null,
      exp: typeof frontmatter.exp === "number" && Number.isFinite(frontmatter.exp) ? frontmatter.exp : null,
      expState: frontmatter.exp_state === "earned"
        ? "earned"
        : frontmatter.exp_state === "planned" ? "planned" : null,
      recurrence: scalar(frontmatter.recurrence),
      dependencies: this.dependencies(frontmatter.blockedBy),
      timeTrackingActive: Array.isArray(frontmatter.timeEntries)
        && frontmatter.timeEntries.some((entry) => {
          const row = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
          return !row.endTime;
        }),
      completed: completedTaskStatus(status),
      provider: "markdown",
      citation: citationForTask(file.path)
    };
  }

  private normalizedPatch(patch: TaskPatch): Partial<BrainTask> {
    return {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.status !== undefined ? {
        status: patch.status,
        completed: completedTaskStatus(patch.status)
      } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.due !== undefined ? { due: patch.due } : {}),
      ...(patch.scheduled !== undefined ? { scheduled: patch.scheduled } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.contexts !== undefined ? { contexts: patch.contexts } : {}),
      ...(patch.projects !== undefined ? { projects: patch.projects } : {}),
      ...(patch.timeEstimate !== undefined ? { timeEstimate: patch.timeEstimate } : {}),
      ...(patch.recurrence !== undefined ? { recurrence: patch.recurrence } : {})
      , ...(patch.dependencies !== undefined ? { dependencies: patch.dependencies.map((dependency) => ({
        uid: dependency.uid,
        reltype: dependency.reltype ?? "FINISHTOSTART"
      })) } : {})
    };
  }

  private dependencies(value: unknown): Array<{ uid: string; reltype: string }> {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
      const row = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
      const uid = scalar(row.uid);
      return uid ? [{ uid, reltype: scalar(row.reltype) ?? "FINISHTOSTART" }] : [];
    });
  }

  private requireFile(path: string): TFile {
    const normalized = normalizePath(path);
    if (!isVaultPathSafe(normalized)) throw new Error("Task path is outside the permitted vault area.");
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (!(file instanceof TFile) || file.extension !== "md") throw new Error(`Task not found: ${path}`);
    return file;
  }

  private folder(): string {
    return normalizePath(this.getFolder().trim() || "TaskNotes/Tasks").replace(/^\/+|\/+$/g, "");
  }

  private uniquePath(title: string): string {
    const slug = title.normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[\\/:*?"<>|#^[\]]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100) || "task";
    const folder = this.folder();
    let path = normalizePath(`${folder}/${slug}.md`);
    let suffix = 2;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = normalizePath(`${folder}/${slug} ${suffix}.md`);
      suffix += 1;
    }
    return path;
  }
}
