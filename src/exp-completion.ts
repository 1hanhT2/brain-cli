import type { BrainTask } from "./task-provider";
import type { ExpAutoScorer } from "./exp-auto-scorer";
import type { ExpCompletionQueueStore } from "./exp-completion-queue";
import { completionMeetsCutoff, completionProposalId, type ExpCompletionProposal } from "./exp-completion-core";
import type { ExpRecordInput, TaskExpState } from "./exp-core";
import type { ExpService } from "./exp-service";
import type { BrainSettings } from "./settings";
import type { TaskService } from "./task-service";

interface CompletionObservation {
  token: string;
  at: string;
  dated: boolean;
}

type ProcessOutcome = "awarded" | "queued" | "needs-score" | "skipped";

export interface ExpCompletionReconcileResult {
  scanned: number;
  discovered: number;
  awarded: number;
  queued: number;
  needsScore: number;
  skipped: number;
  failed: number;
}

export interface ExpCompletionStatus {
  enabled: boolean;
  automaticAwards: boolean;
  automaticScoring: boolean;
  pending: number;
  needsScore: number;
  cutoffDate: string;
}

const cancelled = (task: BrainTask): boolean =>
  ["cancelled", "canceled"].includes(task.status.trim().toLocaleLowerCase());

const observationsFor = (task: BrainTask, now = new Date()): CompletionObservation[] => {
  const instances = [...new Set(task.completedInstances.map((value) => value.trim()).filter(Boolean))];
  if (instances.length > 0) {
    return instances.map((value) => ({ token: `instance:${value}`, at: value, dated: true }));
  }
  if (!task.completed || cancelled(task)) return [];
  return [{ token: "once", at: task.completedDate || now.toISOString(), dated: Boolean(task.completedDate) }];
};

export class ExpCompletionCoordinator {
  private pendingTimer = new Map<string, number>();
  private disposed = false;

  constructor(
    private readonly taskService: TaskService,
    private readonly expService: ExpService,
    private readonly scorer: ExpAutoScorer,
    private readonly queueStore: ExpCompletionQueueStore,
    private readonly getSettings: () => BrainSettings,
    private readonly persistLocalState: () => Promise<void>,
    private readonly onAward: (title: string, value: number) => void,
    private readonly onError: (path: string, error: unknown) => void
  ) {}

  async initialize(): Promise<void> {
    if (this.getSettings().detectCompletedTaskExp && !this.getSettings().completionExpBaselineReady) {
      await this.establishBaseline();
    }
    await this.pruneResolved();
  }

  observe(path: string): void {
    if (this.disposed || !this.getSettings().detectCompletedTaskExp || !path.toLocaleLowerCase().endsWith(".md")) return;
    const previous = this.pendingTimer.get(path);
    if (previous !== undefined) window.clearTimeout(previous);
    this.pendingTimer.set(path, window.setTimeout(() => {
      this.pendingTimer.delete(path);
      void this.inspectPath(path).catch((error) => this.onError(path, error));
    }, 1_200));
  }

  async establishBaseline(): Promise<void> {
    const tasks = await this.taskService.list({ includeCompleted: true, limit: 10_000, internalUnbounded: true });
    const seen = this.getSettings().completionExpSeen;
    const cutoff = this.cutoff();
    for (const task of tasks) {
      const tokens = observationsFor(task)
        .filter((item) => !cutoff || !this.eligible(item, false))
        .map((item) => item.token);
      if (tokens.length > 0) seen[task.path] = [...new Set([...(seen[task.path] ?? []), ...tokens])];
    }
    this.getSettings().completionExpBaselineReady = true;
    await this.pruneResolved();
    await this.persistLocalState();
  }

  async reconcileAll(): Promise<ExpCompletionReconcileResult> {
    await this.pruneResolved();
    const tasks = await this.taskService.list({ includeCompleted: true, limit: 10_000, internalUnbounded: true });
    const result: ExpCompletionReconcileResult = {
      scanned: tasks.length,
      discovered: 0,
      awarded: 0,
      queued: 0,
      needsScore: 0,
      skipped: 0,
      failed: 0
    };
    for (const task of tasks) {
      const unseen = observationsFor(task).filter((item) =>
        this.eligible(item, false)
        && !(this.getSettings().completionExpSeen[task.path] ?? []).includes(item.token)
      );
      for (const observation of unseen) {
        result.discovered += 1;
        try {
          const outcome = await this.process(task, observation);
          if (outcome === "awarded") result.awarded += 1;
          else if (outcome === "queued") result.queued += 1;
          else if (outcome === "needs-score") result.needsScore += 1;
          else result.skipped += 1;
          this.markSeen(task.path, observation.token);
        } catch (error) {
          result.failed += 1;
          this.onError(task.path, error);
        }
      }
    }
    await this.persistLocalState();
    return result;
  }

  async pending(): Promise<ExpCompletionProposal[]> {
    await this.pruneResolved();
    return this.queueStore.list();
  }

  async approve(proposals: ExpCompletionProposal[]): Promise<{
    awarded: number;
    failed: Array<{ proposal: ExpCompletionProposal; error: string }>;
  }> {
    let awarded = 0;
    const failed: Array<{ proposal: ExpCompletionProposal; error: string }> = [];
    for (const proposal of proposals) {
      if (proposal.state !== "ready" || !proposal.input) continue;
      try {
        const recorded = await this.expService.record(proposal.input);
        await this.queueStore.remove(proposal);
        this.markSeen(proposal.path, proposal.completionToken);
        awarded += 1;
        this.onAward(recorded.task.title, recorded.exp.value);
      } catch (error) {
        failed.push({
          proposal,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    await this.persistLocalState();
    return { awarded, failed };
  }

  async getStatus(): Promise<ExpCompletionStatus> {
    const pending = await this.pending();
    return {
      enabled: this.getSettings().detectCompletedTaskExp,
      automaticAwards: this.getSettings().autoAwardCompletedTaskExp,
      automaticScoring: this.getSettings().autoScoreCompletedTaskExp,
      pending: pending.length,
      needsScore: pending.filter((item) => item.state === "needs-score").length,
      cutoffDate: this.cutoff()
    };
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const seen = this.getSettings().completionExpSeen;
    if (seen[oldPath]) {
      seen[newPath] = [...new Set([...(seen[newPath] ?? []), ...seen[oldPath]])];
      delete seen[oldPath];
      await this.persistLocalState();
    }
    await this.queueStore.renameTask(oldPath, newPath);
  }

  async forget(path: string): Promise<void> {
    const timer = this.pendingTimer.get(path);
    if (timer !== undefined) window.clearTimeout(timer);
    this.pendingTimer.delete(path);
    if (this.getSettings().completionExpSeen[path]) {
      delete this.getSettings().completionExpSeen[path];
      await this.persistLocalState();
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.pendingTimer.values()) window.clearTimeout(timer);
    this.pendingTimer.clear();
  }

  private async inspectPath(path: string): Promise<void> {
    const task = await this.taskService.get(path, true);
    if (!task) return;
    const sensitivity = await this.taskService.inspectSensitivity(path);
    if (sensitivity.sensitive) {
      for (const observation of observationsFor(task)) this.markSeen(path, observation.token);
      await this.persistLocalState();
      return;
    }
    const seen = new Set(this.getSettings().completionExpSeen[path] ?? []);
    let changed = false;
    for (const observation of observationsFor(task)) {
      if (seen.has(observation.token)) continue;
      if (this.eligible(observation, true)) await this.process(task, observation);
      this.markSeen(path, observation.token);
      changed = true;
    }
    if (changed) await this.persistLocalState();
  }

  private async process(task: BrainTask, observation: CompletionObservation): Promise<ProcessOutcome> {
    const existing = await this.expService.taskState(task.path);
    if (existing?.taskId) {
      const completionId = `${existing.taskId}:${observation.token}`;
      if (await this.expService.hasCompletion(completionId)) return "skipped";
    }
    if (await this.queueStore.getByCompletion(task.path, observation.token)) return "skipped";
    const recurring = Boolean(task.recurrence || task.completedInstances.length > 0);
    if (!recurring && existing?.state === "earned") return "skipped";

    let input: ExpRecordInput | undefined;
    if (existing) {
      const source = await this.expService.latestEvent(task.path);
      input = this.reusePlanned(task.path, observation, existing, recurring, source?.id);
    } else if (this.getSettings().autoScoreCompletedTaskExp) {
      input = (await this.scorer.proposeAward(
        task.path,
        observation.token,
        observation.at
      )).input;
    }

    if (!input) {
      await this.queueStore.save({
        id: completionProposalId(task.path, observation.token),
        path: task.path,
        title: task.title,
        completionToken: observation.token,
        completionAt: observation.at,
        detectedAt: new Date().toISOString(),
        state: "needs-score"
      });
      return "needs-score";
    }

    if (this.getSettings().autoAwardCompletedTaskExp) {
      const recorded = await this.expService.record(input);
      this.onAward(recorded.task.title, recorded.exp.value);
      return "awarded";
    }

    await this.queueStore.save({
      id: completionProposalId(task.path, observation.token),
      path: task.path,
      title: task.title,
      completionToken: observation.token,
      completionAt: observation.at,
      detectedAt: new Date().toISOString(),
      state: "ready",
      input
    });
    return "queued";
  }

  private reusePlanned(
    path: string,
    observation: CompletionObservation,
    state: TaskExpState,
    recurring: boolean,
    sourceEventId?: string
  ): ExpRecordInput {
    return {
      path,
      action: "award",
      value: state.value,
      confidence: state.confidence,
      reason: state.reason,
      factors: state.factors,
      allowRepeat: recurring && state.state === "earned",
      completionToken: observation.token,
      completionAt: observation.at,
      scoringSource: "planned-reuse",
      sourceEventId,
      rubricVersion: 1
    };
  }

  private cutoff(): string {
    return this.getSettings().completionExpCutoffDate?.trim() ?? "";
  }

  private eligible(observation: CompletionObservation, allowUndated: boolean): boolean {
    const cutoff = this.cutoff();
    if (!cutoff) return true;
    if (!observation.dated) return allowUndated;
    return completionMeetsCutoff(observation.at, cutoff);
  }

  private markSeen(path: string, token: string): void {
    this.getSettings().completionExpSeen[path] = [
      ...new Set([...(this.getSettings().completionExpSeen[path] ?? []), token])
    ];
  }

  private async pruneResolved(): Promise<void> {
    for (const proposal of await this.queueStore.list()) {
      if (!completionMeetsCutoff(proposal.completionAt, this.cutoff())) {
        await this.queueStore.remove(proposal);
        this.markSeen(proposal.path, proposal.completionToken);
        continue;
      }
      const state = await this.expService.taskState(proposal.path).catch(() => null);
      if (!state?.taskId) continue;
      if (await this.expService.hasCompletion(`${state.taskId}:${proposal.completionToken}`)) {
        await this.queueStore.remove(proposal);
        this.markSeen(proposal.path, proposal.completionToken);
      }
    }
  }
}
