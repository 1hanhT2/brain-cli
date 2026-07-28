import type { App, TFile } from "obsidian";
import { EXP_EXAMPLES, EXP_RUBRIC } from "./bundled-exp-skill";
import type { ExpFactors, ExpRecordInput } from "./exp-core";
import type { ExpService } from "./exp-service";
import type { OpenRouterClient } from "./openrouter";
import type { BrainSettings } from "./settings";
import type { TaskService } from "./task-service";

const SCORE_DELAY_MS = 1_200;
const MAX_TASK_CONTEXT_CHARACTERS = 12_000;

export interface ExpAutoScoreResult {
  path: string;
  title: string;
  value: number;
  source: "automatic" | "manual";
}

const objectValue = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const textValue = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

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
  private readonly pending = new Map<string, number>();
  private timer: number | null = null;
  private running = false;
  private disposed = false;

  constructor(
    private readonly app: App,
    private readonly taskService: TaskService,
    private readonly expService: ExpService,
    private readonly openRouter: OpenRouterClient,
    private readonly getSettings: () => BrainSettings,
    private readonly onResult: (result: ExpAutoScoreResult) => void,
    private readonly onError: (path: string, error: unknown) => void
  ) {}

  queue(path: string): void {
    if (this.disposed || !this.getSettings().autoScoreTaskExp || !path.toLocaleLowerCase().endsWith(".md")) return;
    this.pending.set(path, 0);
    this.schedule();
  }

  async scoreNow(path: string): Promise<ExpAutoScoreResult> {
    return this.score(path, "manual");
  }

  cancel(): void {
    this.pending.clear();
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  private schedule(): void {
    if (this.timer !== null || this.running || this.disposed) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, SCORE_DELAY_MS);
  }

  private async drain(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      while (this.pending.size > 0 && this.getSettings().autoScoreTaskExp) {
        const path = this.pending.keys().next().value as string | undefined;
        if (!path) break;
        const attempt = this.pending.get(path) ?? 0;
        this.pending.delete(path);
        try {
          const result = await this.score(path, "automatic");
          this.onResult(result);
        } catch (error) {
          if (/Task not found/i.test(error instanceof Error ? error.message : String(error)) && attempt < 2) {
            this.pending.set(path, attempt + 1);
            break;
          } else {
            this.onError(path, error);
          }
        }
      }
    } finally {
      this.running = false;
      if (this.pending.size > 0) this.schedule();
    }
  }

  private async score(path: string, source: "automatic" | "manual"): Promise<ExpAutoScoreResult> {
    const settings = this.getSettings();
    const task = await this.taskService.get(path, true);
    if (!task) throw new Error(`Task not found: ${path}`);
    if (source === "automatic" && task.exp !== null) {
      return { path, title: task.title, value: task.exp, source };
    }
    const sensitivity = await this.taskService.inspectSensitivity(path);
    if (sensitivity.sensitive) {
      throw new Error(`Automatic EXP skipped a sensitive task: ${sensitivity.reasons.join(", ")}`);
    }
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || !("extension" in file) || file.extension !== "md") {
      throw new Error(`Task not found: ${path}`);
    }
    const content = (await this.app.vault.cachedRead(file as TFile)).slice(0, MAX_TASK_CONTEXT_CHARACTERS);
    const existing = await this.expService.taskState(path);
    const action: ExpRecordInput["action"] = existing ? "recalibrate" : "plan";
    const response = await this.openRouter.completeText(
      settings.backgroundModel || settings.interactiveModel,
      [
        "Score one Obsidian task using the supplied EXP rubric.",
        "Return only one JSON object with: value, confidence, reason, and factors.",
        "factors must contain output, difficulty, rigor, friction, independence, and significance.",
        "value must be 25 through 1000 in increments of 25. confidence must be 0 through 1.",
        "Use the task body and metadata, not only its title. Time is supporting context, never the score itself.",
        "",
        EXP_RUBRIC,
        "",
        EXP_EXAMPLES
      ].join("\n"),
      [
        `Task path: ${task.path}`,
        `Task title: ${task.title}`,
        `Status: ${task.status}`,
        `Priority: ${task.priority ?? "none"}`,
        `Due: ${task.due ?? "none"}`,
        "",
        content
      ].join("\n"),
      new AbortController().signal
    );
    const input = this.expService.validate(parseExpScoringResponse(response, path, action));
    const recorded = await this.expService.record(input);
    return {
      path,
      title: recorded.task.title,
      value: recorded.exp.value,
      source
    };
  }
}
