import type { App, TFile } from "obsidian";
import { EXP_EXAMPLES, EXP_RUBRIC } from "./bundled-exp-skill";
import type { ExpFactors, ExpRecordInput } from "./exp-core";
import type { ExpService } from "./exp-service";
import type { OpenRouterClient } from "./openrouter";
import type { AutoExpQueueEntry, BrainSettings } from "./settings";
import type { TaskService } from "./task-service";
import type { OpenRouterModel } from "./types";

const SCORE_DELAY_MS = 1_200;
const RETRY_DELAY_MS = 3_000;
const MAX_ATTEMPTS = 3;
const MAX_TASK_CONTEXT_CHARACTERS = 12_000;

interface PendingScore {
  attempts: number;
  readyAt: number;
}

export interface ExpAutoScoreResult {
  path: string;
  title: string;
  value: number;
  source: "automatic" | "manual";
}

export interface ExpAutoScoreStatus {
  queued: number;
  running: boolean;
  estimatedSpendUsd: number;
  capUsd: number;
}

const objectValue = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const textValue = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const abortError = (): DOMException =>
  new DOMException("The operation was aborted.", "AbortError");

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";

export const parseExpScoringResponse = (
  response: string,
  path: string,
  action: ExpRecordInput["action"]
): ExpRecordInput => {
  const fenced = response.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = (fenced ?? response).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The EXP model did not return a JSON score.");
  const parsed = objectValue(JSON.parse(candidate.slice(start, end + 1)));
  const factors = objectValue(parsed.factors);
  const rawValue = typeof parsed.value === "number" ? parsed.value : Number(parsed.value);
  const rawConfidence = typeof parsed.confidence === "number"
    ? parsed.confidence
    : Number(parsed.confidence);
  if (!Number.isFinite(rawValue) || !Number.isFinite(rawConfidence)) {
    throw new Error("The EXP model returned an invalid numeric score or confidence.");
  }
  const normalizedFactors: ExpFactors = {
    output: textValue(factors.output),
    difficulty: textValue(factors.difficulty),
    rigor: textValue(factors.rigor),
    friction: textValue(factors.friction),
    independence: textValue(factors.independence),
    significance: textValue(factors.significance)
  };
  return {
    path,
    action,
    value: Math.min(1_000, Math.max(25, Math.round(rawValue / 25) * 25)),
    confidence: Math.min(1, Math.max(0, rawConfidence)),
    reason: textValue(parsed.reason),
    factors: normalizedFactors
  };
};

export class ExpAutoScorer {
  private readonly pending = new Map<string, PendingScore>();
  private readonly candidates = new Set<string>();
  private readonly qualifying = new Set<string>();
  private readonly restored = new Map<string, PendingScore>();
  private timer: number | null = null;
  private running = false;
  private disposed = false;
  private activeController: AbortController | null = null;
  private estimatedSpendUsd = 0;
  private persistence: Promise<void> = Promise.resolve();

  constructor(
    private readonly app: App,
    private readonly taskService: TaskService,
    private readonly expService: ExpService,
    private readonly openRouter: OpenRouterClient,
    private readonly getSettings: () => BrainSettings,
    private readonly getModel: (id: string) => OpenRouterModel | undefined,
    private readonly persistQueue: (entries: AutoExpQueueEntry[]) => Promise<void>,
    private readonly onResult: (result: ExpAutoScoreResult) => void,
    private readonly onError: (path: string, error: unknown) => void
  ) {}

  resumeQueued(): void {
    if (this.disposed || !this.getSettings().autoScoreTaskExp) return;
    for (const entry of this.getSettings().autoExpQueue) {
      this.candidates.add(entry.path);
      this.restored.set(entry.path, {
        attempts: Math.min(Math.max(Math.floor(entry.attempts), 0), MAX_ATTEMPTS - 1),
        readyAt: Math.max(Date.now(), entry.readyAt)
      });
      void this.qualify(entry.path);
    }
  }

  queue(path: string): void {
    if (
      this.disposed
      || !this.getSettings().autoScoreTaskExp
      || !path.toLocaleLowerCase().endsWith(".md")
    ) return;
    this.restored.delete(path);
    this.candidates.add(path);
    void this.qualify(path);
  }

  touch(path: string): void {
    const item = this.pending.get(path);
    if (!item) return;
    item.readyAt = Date.now() + SCORE_DELAY_MS;
    this.pending.set(path, item);
    this.schedule();
  }

  resolveCandidate(path: string): void {
    if (!this.candidates.has(path)) return;
    void this.qualify(path);
  }

  forget(path: string): void {
    const candidateChanged = this.candidates.delete(path);
    const restoredChanged = this.restored.delete(path);
    const pendingChanged = this.pending.delete(path);
    this.qualifying.delete(path);
    if (candidateChanged || restoredChanged || pendingChanged) this.persist();
  }

  async scoreNow(path: string): Promise<ExpAutoScoreResult> {
    return this.score(path, "manual");
  }

  getStatus(): ExpAutoScoreStatus {
    return {
      queued: this.pending.size,
      running: this.running,
      estimatedSpendUsd: this.estimatedSpendUsd,
      capUsd: this.getSettings().autoExpSpendCapUsd
    };
  }

  cancel(): void {
    this.activeController?.abort();
    this.activeController = null;
    this.pending.clear();
    this.candidates.clear();
    this.qualifying.clear();
    this.restored.clear();
    this.clearTimer();
    this.persist();
  }

  dispose(): void {
    this.disposed = true;
    this.activeController?.abort();
    this.activeController = null;
    this.candidates.clear();
    this.qualifying.clear();
    this.restored.clear();
    this.clearTimer();
    this.persist();
  }

  private schedule(): void {
    if (this.timer !== null || this.running || this.disposed || this.pending.size === 0) return;
    const nextReadyAt = Math.min(...[...this.pending.values()].map((item) => item.readyAt));
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, Math.max(0, nextReadyAt - Date.now()));
  }

  private async drain(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      while (this.pending.size > 0 && this.getSettings().autoScoreTaskExp && !this.disposed) {
        const next = [...this.pending.entries()]
          .sort((left, right) => left[1].readyAt - right[1].readyAt)[0];
        if (!next) break;
        const [path, item] = next;
        if (item.readyAt > Date.now()) break;
        this.pending.delete(path);
        this.persist();
        try {
          const result = await this.score(path, "automatic");
          if (!this.disposed) this.onResult(result);
        } catch (error) {
          if (isAbortError(error)) break;
          const permanent = /sensitive task|already has earned EXP|spend cap|pricing is unavailable/i.test(
            error instanceof Error ? error.message : String(error)
          );
          if (!permanent && item.attempts + 1 < MAX_ATTEMPTS) {
            this.pending.set(path, {
              attempts: item.attempts + 1,
              readyAt: Date.now() + RETRY_DELAY_MS * (item.attempts + 1)
            });
            this.persist();
          } else {
            this.onError(path, error);
          }
        }
      }
    } finally {
      this.running = false;
      if (this.pending.size > 0 && this.getSettings().autoScoreTaskExp && !this.disposed) this.schedule();
    }
  }

  private async score(path: string, source: "automatic" | "manual"): Promise<ExpAutoScoreResult> {
    if (source === "automatic" && this.activeController) {
      throw new Error("Another EXP scoring request is already running.");
    }
    const controller = new AbortController();
    this.activeController?.abort();
    this.activeController = controller;
    try {
      const settings = this.getSettings();
      const task = await this.taskService.get(path, true);
      if (!task) throw new Error(`Task not found: ${path}`);
      if (source === "automatic" && task.exp !== null) {
        return { path, title: task.title, value: task.exp, source };
      }
      const sensitivity = await this.taskService.inspectSensitivity(path);
      if (sensitivity.sensitive) {
        throw new Error(`EXP scoring skipped a sensitive task: ${sensitivity.reasons.join(", ")}`);
      }
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!file || !("extension" in file) || file.extension !== "md") {
        throw new Error(`Task not found: ${path}`);
      }
      const content = (await this.app.vault.cachedRead(file as TFile)).slice(0, MAX_TASK_CONTEXT_CHARACTERS);
      const existing = await this.expService.taskState(path);
      if (existing?.state === "earned") {
        throw new Error("This task already has earned EXP and cannot be rescored as planned work.");
      }
      const action: ExpRecordInput["action"] = existing ? "recalibrate" : "plan";
      const systemPrompt = [
        "Score one Obsidian task using the supplied EXP rubric.",
        "Return only one JSON object with: value, confidence, reason, and factors.",
        "factors must contain output, difficulty, rigor, friction, independence, and significance.",
        "value must be 25 through 1000 in increments of 25. confidence must be 0 through 1.",
        "Use the task body and metadata, not only its title. Time is supporting context, never the score itself.",
        "",
        EXP_RUBRIC,
        "",
        EXP_EXAMPLES
      ].join("\n");
      const userPrompt = [
        `Task path: ${task.path}`,
        `Task title: ${task.title}`,
        `Status: ${task.status}`,
        `Priority: ${task.priority ?? "none"}`,
        `Due: ${task.due ?? "none"}`,
        "",
        content
      ].join("\n");
      const modelId = settings.backgroundModel || settings.interactiveModel;
      const estimated = source === "automatic"
        ? this.estimateRequestCost(modelId, systemPrompt, userPrompt)
        : 0;
      if (source === "automatic") this.ensureWithinSpendCap(estimated);
      const response = await this.openRouter.completeTextWithUsage(
        modelId,
        systemPrompt,
        userPrompt,
        controller.signal
      );
      if (controller.signal.aborted) throw abortError();
      if (source === "automatic") {
        this.estimatedSpendUsd += this.actualRequestCost(
          modelId,
          response.promptTokens,
          response.completionTokens
        ) ?? estimated;
      }
      const input = this.expService.validate(parseExpScoringResponse(response.content, path, action));
      if (controller.signal.aborted) throw abortError();
      const recorded = await this.expService.record(input, controller.signal);
      return {
        path,
        title: recorded.task.title,
        value: recorded.exp.value,
        source
      };
    } finally {
      if (this.activeController === controller) {
        this.activeController = null;
      }
    }
  }

  private isLikelyTask(path: string): boolean {
    const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "");
    const folder = this.getSettings().fallbackTaskFolder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (folder && (normalized === folder || normalized.startsWith(`${folder}/`))) return true;
    const frontmatter = this.app.metadataCache.getCache(normalized)?.frontmatter;
    return typeof frontmatter?.status === "string";
  }

  private async qualify(path: string): Promise<void> {
    if (
      this.disposed
      || this.qualifying.has(path)
      || !this.candidates.has(path)
      || !this.isLikelyTask(path)
    ) return;
    this.qualifying.add(path);
    try {
      const sensitivity = await this.taskService.inspectSensitivity(path);
      if (this.disposed || !this.candidates.has(path) || !this.getSettings().autoScoreTaskExp) return;
      if (sensitivity.sensitive) {
        this.candidates.delete(path);
        this.restored.delete(path);
        this.persist();
        return;
      }
      this.candidates.delete(path);
      const restored = this.restored.get(path);
      this.restored.delete(path);
      this.pending.set(path, restored ?? { attempts: 0, readyAt: Date.now() + SCORE_DELAY_MS });
      this.persist();
      this.schedule();
    } catch (error) {
      if (!/Task not found|Markdown file not found/i.test(error instanceof Error ? error.message : String(error))) {
        this.candidates.delete(path);
        this.restored.delete(path);
        this.persist();
        this.onError(path, error);
      }
    } finally {
      this.qualifying.delete(path);
    }
  }

  private estimateRequestCost(modelId: string, systemPrompt: string, userPrompt: string): number {
    const estimate = this.actualRequestCost(
      modelId,
      Math.ceil((systemPrompt.length + userPrompt.length) / 4),
      1_024
    );
    if (estimate === null) {
      if (this.getSettings().autoExpSpendCapUsd <= 0) return 0;
      throw new Error("Automatic EXP model pricing is unavailable; choose a priced/free model or use manual @exp scoring.");
    }
    return estimate;
  }

  private actualRequestCost(modelId: string, promptTokens: number, completionTokens: number): number | null {
    if (modelId === "openrouter/free" || modelId.endsWith(":free")) return 0;
    const pricing = this.getModel(modelId)?.pricing;
    const prompt = Number.parseFloat(pricing?.prompt ?? "");
    const completion = Number.parseFloat(pricing?.completion ?? "");
    if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return null;
    return promptTokens * prompt + completionTokens * completion;
  }

  private ensureWithinSpendCap(nextCost: number): void {
    const cap = this.getSettings().autoExpSpendCapUsd;
    if (cap > 0 && this.estimatedSpendUsd + nextCost > cap) {
      throw new Error(
        `Automatic EXP spend cap reached: estimated $${(this.estimatedSpendUsd + nextCost).toFixed(4)} exceeds $${cap.toFixed(2)}.`
      );
    }
  }

  private persist(): void {
    const snapshot = [...this.pending].map(([path, item]) => ({
      path,
      attempts: item.attempts,
      readyAt: item.readyAt
    }));
    this.persistence = this.persistence.then(() => this.persistQueue(snapshot)).catch((error) =>
      console.error("[Obsidian Brain] Could not persist the automatic EXP queue.", error)
    );
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    window.clearTimeout(this.timer);
    this.timer = null;
  }
}
