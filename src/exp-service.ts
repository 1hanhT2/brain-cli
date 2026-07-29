import { normalizePath, parseYaml, TFile, type App } from "obsidian";
import type { TaskService } from "./task-service";
import type { VaultTools } from "./vault-tools";
import { isVaultPathSafe } from "./permissions";
import {
  calculateExpStreaks,
  expNumber,
  expString,
  localDateKey,
  parseExpFactors,
  validateExpInput,
  validateExpTransition,
  type ExpCalibrationReview,
  type ExpLedgerEntry,
  type ExpProgress,
  type ExpRecordInput,
  type TaskExpState
} from "./exp-core";
import { formatExpTaskTitle, stripExpTitlePrefix } from "./task-provider";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const EXP_SCHEMA_VERSION = 2;
const EXP_FRONTMATTER_KEYS = [
  "title", "exp_schema", "exp", "exp_state", "exp_confidence", "exp_reason",
  "exp_factors", "exp_scored_at", "exp_awarded_at", "exp_revision",
  "exp_task_id", "exp_last_completion_id"
];

const uniqueId = (): string =>
  typeof crypto?.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

export class ExpService {
  constructor(
    private readonly app: App,
    private readonly vaultTools: VaultTools,
    private readonly taskService: TaskService,
    private readonly getExpRoot: () => string,
    private readonly getTitleMaxLength: () => number = () => 100
  ) {}

  validate(input: ExpRecordInput): ExpRecordInput {
    return validateExpInput(input);
  }

  async taskState(path: string): Promise<TaskExpState | null> {
    const file = this.requireFile(path);
    const frontmatter = await this.frontmatter(file);
    const value = expNumber(frontmatter.exp, Number.NaN);
    if (!Number.isFinite(value)) return null;
    const state = frontmatter.exp_state === "earned" ? "earned" : "planned";
    return {
      schema: expNumber(frontmatter.exp_schema, EXP_SCHEMA_VERSION),
      value,
      state,
      confidence: expNumber(frontmatter.exp_confidence),
      reason: expString(frontmatter.exp_reason),
      factors: parseExpFactors(frontmatter.exp_factors),
      scoredAt: expString(frontmatter.exp_scored_at),
      awardedAt: state === "earned" ? expString(frontmatter.exp_awarded_at) || null : null,
      revision: expNumber(frontmatter.exp_revision),
      taskId: expString(frontmatter.exp_task_id),
      lastCompletionId: expString(frontmatter.exp_last_completion_id) || null
    };
  }

  async hasCompletion(completionId: string): Promise<boolean> {
    if (!completionId) return false;
    return (await this.history()).some((entry) =>
      entry.action === "award" && entry.completionId === completionId
    );
  }

  async latestEvent(path: string): Promise<ExpLedgerEntry | null> {
    return (await this.history()).find((entry) => entry.taskPath === path) ?? null;
  }

  async record(input: ExpRecordInput, signal?: AbortSignal): Promise<{
    task: { path: string; title: string; displayTitle: string; citation: string };
    exp: TaskExpState;
    ledger: ExpLedgerEntry;
    verified: true;
  }> {
    const clean = this.validate(input);
    if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    const task = await this.taskService.get(clean.path, true);
    if (!task) throw new Error(`Task not found: ${clean.path}`);
    const existing = await this.taskState(task.path);
    const taskId = existing?.taskId || uniqueId();
    const completionId = clean.completionToken ? `${taskId}:${clean.completionToken}` : undefined;
    if (completionId && await this.hasCompletion(completionId)) {
      throw new Error("This task completion already has an EXP award.");
    }
    validateExpTransition(
      clean.action,
      existing,
      clean.allowRepeat || Boolean(completionId && existing?.state === "earned")
    );

    const now = new Date().toISOString();
    const revision = (existing?.revision ?? 0) + 1;
    const plainTitle = stripExpTitlePrefix(task.title);
    const storedTitle = formatExpTaskTitle(plainTitle, clean.value, this.getTitleMaxLength());
    const sensitivity = await this.taskService.inspectSensitivity(task.path);
    const ledger = this.makeLedgerEntry(
      clean,
      plainTitle,
      now,
      revision,
      sensitivity.sensitive,
      taskId,
      completionId
    );
    const taskFile = this.requireFile(task.path);
    const before = await this.frontmatter(taskFile);
    try {
      if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
      await this.vaultTools.updateFrontmatter(task.path, {
        title: storedTitle,
        exp_schema: EXP_SCHEMA_VERSION,
        exp: clean.value,
        exp_state: clean.action === "award" ? "earned" : "planned",
        exp_confidence: clean.confidence,
        exp_reason: clean.reason,
        exp_factors: clean.factors,
        exp_scored_at: now,
        exp_awarded_at: clean.action === "award" ? now : null,
        exp_revision: revision,
        exp_task_id: taskId,
        exp_last_completion_id: completionId ?? existing?.lastCompletionId ?? null
      });
      const verified = await this.taskState(task.path);
      if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
      if (!verified || verified.value !== clean.value || verified.revision !== revision) {
        throw new Error(`EXP metadata could not be verified after writing ${task.path}.`);
      }
      await this.vaultTools.createMarkdown(
        this.ledgerPath(ledger),
        this.renderLedger(ledger, task.citation)
      );
      return {
        task: {
          path: task.path,
          title: storedTitle,
          displayTitle: storedTitle,
          citation: task.citation
        },
        exp: verified,
        ledger,
        verified: true
      };
    } catch (error) {
      await this.vaultTools.restoreFrontmatter(task.path, before, EXP_FRONTMATTER_KEYS).catch((rollbackError) => {
        console.error(`[Obsidian Brain] Failed to roll back EXP metadata for ${task.path}.`, rollbackError);
      });
      throw error;
    }
  }

  async history(): Promise<ExpLedgerEntry[]> {
    const root = normalizePath(`${this.getExpRoot()}/Ledger`).replace(/^\/+|\/+$/g, "");
    const entries: ExpLedgerEntry[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (file.path !== root && !file.path.startsWith(`${root}/`)) continue;
      const frontmatter = await this.frontmatter(file);
      if (frontmatter.type !== "exp-entry") continue;
      const action = frontmatter.action;
      if (action !== "plan" && action !== "award" && action !== "recalibrate") continue;
      const taskPath = expString(frontmatter.task);
      let sensitive = frontmatter.sensitive === true;
      if (!sensitive && taskPath) {
        sensitive = await this.taskService.inspectSensitivity(taskPath)
          .then((report) => report.sensitive)
          .catch(() => false);
      }
      entries.push({
        id: expString(frontmatter.id),
        action,
        taskPath,
        taskTitle: expString(frontmatter.task_title),
        value: expNumber(frontmatter.exp),
        confidence: expNumber(frontmatter.confidence),
        reason: expString(frontmatter.reason),
        factors: parseExpFactors(frontmatter.factors),
        recordedAt: expString(frontmatter.recorded_at),
        revision: expNumber(frontmatter.revision),
        citation: `[[${file.path.replace(/\.md$/i, "")}]]`,
        sensitive,
        taskId: expString(frontmatter.exp_task_id) || undefined,
        completionId: expString(frontmatter.completion_id) || undefined,
        completionAt: expString(frontmatter.completion_at) || undefined,
        scoringSource: frontmatter.scoring_source === "manual-ai"
          || frontmatter.scoring_source === "background-ai"
          || frontmatter.scoring_source === "planned-reuse"
          ? frontmatter.scoring_source
          : "manual",
        sourceEventId: expString(frontmatter.source_event_id) || undefined,
        modelId: expString(frontmatter.model_id) || undefined,
        provider: expString(frontmatter.provider) || undefined,
        promptTokens: Number.isFinite(expNumber(frontmatter.prompt_tokens, Number.NaN))
          ? expNumber(frontmatter.prompt_tokens)
          : undefined,
        completionTokens: Number.isFinite(expNumber(frontmatter.completion_tokens, Number.NaN))
          ? expNumber(frontmatter.completion_tokens)
          : undefined,
        costUsd: Number.isFinite(expNumber(frontmatter.cost_usd, Number.NaN))
          ? expNumber(frontmatter.cost_usd)
          : undefined,
        rubricVersion: Number.isFinite(expNumber(frontmatter.rubric_version, Number.NaN))
          ? expNumber(frontmatter.rubric_version)
          : undefined
      });
    }
    return entries.sort((left, right) => right.recordedAt.localeCompare(left.recordedAt));
  }

  async progress(now = new Date()): Promise<ExpProgress> {
    const history = await this.history();
    const awards = history.filter((entry) => entry.action === "award");
    const awardTimestamp = (entry: ExpLedgerEntry) => entry.completionAt || entry.recordedAt;
    const total = awards.reduce((sum, entry) => sum + entry.value, 0);
    const since = (days: number) => {
      const cutoff = new Date(now);
      cutoff.setDate(cutoff.getDate() - days);
      return awards
        .filter((entry) => new Date(awardTimestamp(entry)) >= cutoff)
        .reduce((sum, entry) => sum + entry.value, 0);
    };
    const today = localDateKey(now);
    const streaks = calculateExpStreaks(
      awards.map((entry) => ({ ...entry, recordedAt: awardTimestamp(entry) })),
      now
    );
    const level = Math.floor(total / 1000) + 1;
    return {
      total,
      today: awards
        .filter((entry) => localDateKey(awardTimestamp(entry)) === today)
        .reduce((sum, entry) => sum + entry.value, 0),
      last7Days: since(7),
      last30Days: since(30),
      currentStreak: streaks.current,
      longestStreak: streaks.longest,
      level,
      levelProgress: total % 1000,
      nextLevelAt: level * 1000,
      awards: awards.length,
      recent: this.redactSensitive(awards.slice(0, 5))
    };
  }

  async review(days = 30, now = new Date()): Promise<ExpCalibrationReview> {
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - Math.min(Math.max(Math.floor(days), 1), 365));
    const awards = (await this.history())
      .filter((entry) => entry.action === "award" && new Date(entry.recordedAt) >= cutoff);
    const values = awards.map((entry) => entry.value).sort((left, right) => left - right);
    const average = values.length
      ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
      : 0;
    const middle = Math.floor(values.length / 2);
    const median = values.length === 0
      ? 0
      : values.length % 2
        ? values[middle]
        : Math.round((values[middle - 1] + values[middle]) / 2);
    const ranges = [
      { label: "25-75 tiny", min: 25, max: 75 },
      { label: "100-200 ordinary", min: 100, max: 200 },
      { label: "225-400 substantial", min: 225, max: 400 },
      { label: "425-700 major", min: 425, max: 700 },
      { label: "725-1000 exceptional", min: 725, max: 1000 }
    ];
    const counts = new Map<number, number>();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    const lowConfidence = awards.filter((entry) => entry.confidence < 0.6).length;
    const exceptional = values.filter((value) => value >= 725).length;
    const mostCommon = [...counts.entries()].sort((left, right) => right[1] - left[1])[0];
    const observations: string[] = [];
    if (awards.length === 0) observations.push("No awards in this period; record completed work before calibrating the distribution.");
    if (awards.length > 0 && lowConfidence / awards.length >= 0.25) {
      observations.push("At least 25% of awards are low-confidence; review their task context and nearby examples.");
    }
    if (awards.length >= 5 && exceptional / awards.length > 0.1) {
      observations.push("Exceptional 725-1000 scores exceed 10% of awards; the rubric says to use this band rarely.");
    }
    if (awards.length >= 5 && mostCommon && mostCommon[1] / awards.length >= 0.6) {
      observations.push(`The ${mostCommon[0]} score accounts for at least 60% of awards; check whether different outputs are being distinguished enough.`);
    }
    if (awards.length > 0 && observations.length === 0) {
      observations.push("No obvious calibration warning was detected in this period.");
    }
    return {
      days: Math.min(Math.max(Math.floor(days), 1), 365),
      awards: awards.length,
      average,
      median,
      lowConfidence,
      buckets: ranges.map((range) => ({
        label: range.label,
        count: values.filter((value) => value >= range.min && value <= range.max).length
      })),
      commonScores: [...counts.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((left, right) => right.count - left.count || left.value - right.value)
        .slice(0, 5),
      observations,
      recent: this.redactSensitive(awards.slice(0, 10))
    };
  }

  private makeLedgerEntry(
    input: ExpRecordInput,
    taskTitle: string,
    recordedAt: string,
    revision: number,
    sensitive: boolean,
    taskId: string,
    completionId?: string
  ): ExpLedgerEntry {
    const id = uniqueId();
    return {
      id,
      action: input.action,
      taskPath: input.path,
      taskTitle,
      value: input.value,
      confidence: input.confidence,
      reason: input.reason,
      factors: input.factors,
      recordedAt,
      revision,
      citation: "",
      sensitive,
      taskId,
      completionId,
      completionAt: input.completionAt,
      scoringSource: input.scoringSource ?? "manual",
      sourceEventId: input.sourceEventId,
      modelId: input.modelId,
      provider: input.provider,
      promptTokens: input.promptTokens,
      completionTokens: input.completionTokens,
      costUsd: input.costUsd,
      rubricVersion: input.rubricVersion ?? 1
    };
  }

  private ledgerPath(entry: ExpLedgerEntry): string {
    const month = entry.recordedAt.slice(0, 7);
    return normalizePath(`${this.getExpRoot()}/Ledger/${month}/${entry.recordedAt.replace(/[:.]/g, "-")}-${entry.id}.md`);
  }

  private renderLedger(entry: ExpLedgerEntry, taskCitation: string): string {
    return [
      "---",
      `type: exp-entry`,
      `schema: ${EXP_SCHEMA_VERSION}`,
      `id: ${JSON.stringify(entry.id)}`,
      `action: ${entry.action}`,
      `task: ${JSON.stringify(entry.taskPath)}`,
      `task_title: ${JSON.stringify(entry.taskTitle)}`,
      `exp: ${entry.value}`,
      `confidence: ${entry.confidence}`,
      `reason: ${JSON.stringify(entry.reason)}`,
      `factors: ${JSON.stringify(entry.factors)}`,
      `recorded_at: ${JSON.stringify(entry.recordedAt)}`,
      `revision: ${entry.revision}`,
      `exp_task_id: ${JSON.stringify(entry.taskId ?? "")}`,
      `completion_id: ${JSON.stringify(entry.completionId ?? "")}`,
      `completion_at: ${JSON.stringify(entry.completionAt ?? "")}`,
      `scoring_source: ${entry.scoringSource ?? "manual"}`,
      `source_event_id: ${JSON.stringify(entry.sourceEventId ?? "")}`,
      `model_id: ${JSON.stringify(entry.modelId ?? "")}`,
      `provider: ${JSON.stringify(entry.provider ?? "")}`,
      `prompt_tokens: ${JSON.stringify(entry.promptTokens ?? null)}`,
      `completion_tokens: ${JSON.stringify(entry.completionTokens ?? null)}`,
      `cost_usd: ${JSON.stringify(entry.costUsd ?? null)}`,
      `rubric_version: ${entry.rubricVersion ?? 1}`,
      `sensitive: ${entry.sensitive === true}`,
      "---",
      "",
      `# ${entry.action === "award" ? "EXP earned" : "EXP score"}: ${entry.taskTitle}`,
      "",
      `- Task: ${taskCitation}`,
      `- EXP: **${entry.value}**`,
      `- Action: ${entry.action}`,
      `- Confidence: ${Math.round(entry.confidence * 100)}%`,
      `- Source: ${entry.scoringSource ?? "manual"}${entry.modelId ? ` via \`${entry.modelId}\`` : ""}`,
      ...(entry.completionAt ? [`- Completed: ${entry.completionAt}`] : []),
      ...(entry.promptTokens !== undefined || entry.completionTokens !== undefined
        ? [`- Usage: ${(entry.promptTokens ?? 0).toLocaleString()} input + ${(entry.completionTokens ?? 0).toLocaleString()} output tokens${entry.costUsd !== undefined ? ` · $${entry.costUsd.toFixed(6)}` : ""}`]
        : []),
      `- Reason: ${entry.reason}`,
      ""
    ].join("\n");
  }

  private requireFile(path: string): TFile {
    const normalized = normalizePath(path);
    if (!isVaultPathSafe(normalized)) throw new Error("EXP task path must be a safe vault-relative Markdown path.");
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (!(file instanceof TFile) || file.extension !== "md") throw new Error(`Task not found: ${path}`);
    return file;
  }

  private redactSensitive(entries: ExpLedgerEntry[]): ExpLedgerEntry[] {
    return entries.map((entry) => entry.sensitive
      ? {
          ...entry,
          taskPath: "[sensitive task]",
          taskTitle: "[sensitive task]",
          reason: "[sensitive]",
          factors: {
            output: "[sensitive]",
            difficulty: "[sensitive]",
            rigor: "[sensitive]",
            friction: "[sensitive]",
            independence: "[sensitive]",
            significance: "[sensitive]"
          },
          citation: ""
        }
      : entry);
  }

  private async frontmatter(file: TFile): Promise<Record<string, unknown>> {
    const match = (await this.app.vault.cachedRead(file)).match(FRONTMATTER_PATTERN);
    return match ? (parseYaml(match[1]) as Record<string, unknown> | null) ?? {} : {};
  }
}
