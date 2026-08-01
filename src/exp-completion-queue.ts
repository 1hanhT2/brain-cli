import { normalizePath, parseYaml, TFile, type App } from "obsidian";
import { brainPath } from "./data-layout";
import { parseExpFactors, type ExpRecordInput } from "./exp-core";
import type { BrainSettings } from "./settings";
import {
  completionProposalId,
  type ExpCompletionProposal,
  type ExpCompletionProposalState
} from "./exp-completion-core";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const QUEUE_SCHEMA = 1;

export type { ExpCompletionProposal, ExpCompletionProposalState } from "./exp-completion-core";

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export class ExpCompletionQueueStore {
  constructor(
    private readonly app: App,
    private readonly getSettings: () => BrainSettings
  ) {}

  root(): string {
    return brainPath(this.getSettings(), "Queue/EXP/Pending");
  }

  async list(): Promise<ExpCompletionProposal[]> {
    const root = this.root();
    const proposals: ExpCompletionProposal[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(`${root}/`)) continue;
      try {
        const proposal = await this.read(file);
        if (proposal) proposals.push(proposal);
      } catch (error) {
        console.warn(`[Brain CLI] Could not read EXP queue item ${file.path}.`, error);
      }
    }
    return proposals.sort((left, right) =>
      left.detectedAt.localeCompare(right.detectedAt) || left.path.localeCompare(right.path)
    );
  }

  async getByCompletion(path: string, completionToken: string): Promise<ExpCompletionProposal | null> {
    const id = completionProposalId(path, completionToken);
    const file = this.app.vault.getAbstractFileByPath(normalizePath(`${this.root()}/${id}.md`));
    return file instanceof TFile ? this.read(file) : null;
  }

  async save(proposal: ExpCompletionProposal): Promise<ExpCompletionProposal> {
    const id = proposal.id || completionProposalId(proposal.path, proposal.completionToken);
    const normalized = { ...proposal, id };
    const path = normalizePath(`${this.root()}/${id}.md`);
    const content = this.render(normalized);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.app.vault.modify(existing, content);
    else await this.app.vault.create(path, content);
    return { ...normalized, queuePath: path };
  }

  async remove(proposal: ExpCompletionProposal): Promise<void> {
    const path = proposal.queuePath
      ?? normalizePath(`${this.root()}/${proposal.id || completionProposalId(proposal.path, proposal.completionToken)}.md`);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) await this.app.fileManager.trashFile(file);
  }

  async renameTask(oldPath: string, newPath: string): Promise<void> {
    for (const proposal of await this.list()) {
      if (proposal.path !== oldPath) continue;
      const previous = proposal.queuePath;
      const moved = await this.save({
        ...proposal,
        id: completionProposalId(newPath, proposal.completionToken),
        path: newPath,
        input: proposal.input ? { ...proposal.input, path: newPath } : undefined,
        queuePath: undefined
      });
      if (previous && previous !== moved.queuePath) {
        const old = this.app.vault.getAbstractFileByPath(previous);
        if (old instanceof TFile) await this.app.fileManager.trashFile(old);
      }
    }
  }

  private async read(file: TFile): Promise<ExpCompletionProposal | null> {
    const content = await this.app.vault.cachedRead(file);
    const match = content.match(FRONTMATTER_PATTERN);
    if (!match) return null;
    const row = (parseYaml(match[1]) ?? {}) as Record<string, unknown>;
    if (row.type !== "exp-completion-proposal" || row.schema !== QUEUE_SCHEMA) return null;
    const state = row.state;
    if (state !== "ready" && state !== "needs-score" && state !== "failed") return null;
    const path = text(row.task);
    const completionToken = text(row.completion_token);
    if (!path || !completionToken) return null;
    const value = number(row.exp);
    const confidence = number(row.confidence);
    const action = row.action;
    const input = value !== undefined
      && confidence !== undefined
      && action === "award"
      ? {
          path,
          action,
          value,
          confidence,
          reason: text(row.reason),
          factors: parseExpFactors(row.factors),
          allowRepeat: row.allow_repeat === true,
          completionToken,
          completionAt: text(row.completion_at),
          scoringSource: row.scoring_source === "background-ai"
            || row.scoring_source === "planned-reuse"
            || row.scoring_source === "manual-ai"
            ? row.scoring_source
            : "manual",
          sourceEventId: text(row.source_event_id) || undefined,
          modelId: text(row.model_id) || undefined,
          provider: text(row.provider) || undefined,
          promptTokens: number(row.prompt_tokens),
          completionTokens: number(row.completion_tokens),
          costUsd: number(row.cost_usd),
          rubricVersion: number(row.rubric_version)
        } satisfies ExpRecordInput
      : undefined;
    return {
      id: text(row.id) || file.basename,
      path,
      title: text(row.task_title),
      completionToken,
      completionAt: text(row.completion_at),
      detectedAt: text(row.detected_at),
      state,
      input,
      error: text(row.error) || undefined,
      queuePath: file.path
    };
  }

  private render(proposal: ExpCompletionProposal): string {
    const input = proposal.input;
    return [
      "---",
      "type: exp-completion-proposal",
      `schema: ${QUEUE_SCHEMA}`,
      `id: ${JSON.stringify(proposal.id)}`,
      `state: ${proposal.state}`,
      `task: ${JSON.stringify(proposal.path)}`,
      `task_title: ${JSON.stringify(proposal.title)}`,
      `completion_token: ${JSON.stringify(proposal.completionToken)}`,
      `completion_at: ${JSON.stringify(proposal.completionAt)}`,
      `detected_at: ${JSON.stringify(proposal.detectedAt)}`,
      ...(input ? [
        "action: award",
        `exp: ${input.value}`,
        `confidence: ${input.confidence}`,
        `reason: ${JSON.stringify(input.reason)}`,
        `factors: ${JSON.stringify(input.factors)}`,
        `allow_repeat: ${input.allowRepeat === true}`,
        `scoring_source: ${input.scoringSource ?? "manual"}`,
        `source_event_id: ${JSON.stringify(input.sourceEventId ?? "")}`,
        `model_id: ${JSON.stringify(input.modelId ?? "")}`,
        `provider: ${JSON.stringify(input.provider ?? "")}`,
        `prompt_tokens: ${JSON.stringify(input.promptTokens ?? null)}`,
        `completion_tokens: ${JSON.stringify(input.completionTokens ?? null)}`,
        `cost_usd: ${JSON.stringify(input.costUsd ?? null)}`,
        `rubric_version: ${input.rubricVersion ?? 1}`
      ] : []),
      `error: ${JSON.stringify(proposal.error ?? "")}`,
      "---",
      "",
      `# ${proposal.state === "ready" ? "EXP award ready" : proposal.state === "failed" ? "EXP completion failed" : "EXP score needed"}`,
      "",
      `- Task: [[${proposal.path.replace(/\.md$/i, "")}]]`,
      `- Completion: ${proposal.completionAt || proposal.completionToken}`,
      `- Detected: ${proposal.detectedAt}`,
      ...(input ? [
        `- Proposed EXP: **${input.value}**`,
        `- Confidence: ${Math.round(input.confidence * 100)}%`,
        `- Source: ${input.scoringSource ?? "manual"}${input.modelId ? ` via \`${input.modelId}\`` : ""}`,
        `- Reason: ${input.reason}`
      ] : [
        "- Next: run `@exp score` for this task, then approve the proposed award."
      ]),
      ...(proposal.error ? [`- Error: ${proposal.error}`] : []),
      ""
    ].join("\n");
  }
}
