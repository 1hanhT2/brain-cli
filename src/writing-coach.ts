import { normalizePath, parseYaml, TFile, type App } from "obsidian";
import type { OpenRouterClient } from "./openrouter";
import { chooseWritingCoachInterval } from "./writing-coach-core";
import { throwIfAborted } from "./abort";

export type WritingPillar = "cohesion" | "grammar" | "task achievement" | "content" | "organisation";

export interface WritingCoachStatus {
  active: boolean;
  targetPath: string;
  goals: string;
  intervalMinutes: number;
  intervalMaxMinutes: number;
  scheduledIntervalMinutes: number;
  nextCheckAt: string;
  checks: number;
  lastPillar: WritingPillar | null;
  citation: string;
}

interface WritingCoachSession extends WritingCoachStatus {
  pillarBag: WritingPillar[];
  lastHash: string;
  log: string;
}

const PILLARS: WritingPillar[] = [
  "cohesion", "grammar", "task achievement", "content", "organisation"
];
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const MAX_DRAFT_CHARACTERS = 16_000;

const string = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const number = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const hash = (value: string): string => {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
};

const shuffledPillars = (): WritingPillar[] => {
  const values = [...PILLARS];
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [values[index], values[swap]] = [values[swap]!, values[index]!];
  }
  return values;
};

const draftContext = (content: string): string => {
  if (content.length <= MAX_DRAFT_CHARACTERS) return content;
  const half = Math.floor(MAX_DRAFT_CHARACTERS / 2);
  return `${content.slice(0, half)}\n\n[Middle of draft omitted]\n\n${content.slice(-half)}`;
};

export class WritingCoachService {
  private session: WritingCoachSession | null = null;
  private timer: number | null = null;
  private running = false;
  private disposed = false;
  private controller: AbortController | null = null;

  constructor(
    private readonly app: App,
    private readonly openRouter: OpenRouterClient,
    private readonly root: () => string,
    private readonly model: () => string,
    private readonly onNudge: (pillar: WritingPillar, feedback: string, status: WritingCoachStatus) => void,
    private readonly onError: (error: unknown) => void
  ) {}

  async initialize(): Promise<void> {
    this.session = await this.load();
    if (this.session?.active) this.schedule();
  }

  status(): WritingCoachStatus | null {
    return this.session ? this.publicStatus(this.session) : null;
  }

  async start(
    targetPath: string,
    goals: string,
    intervalMinutes = 10,
    intervalMaxMinutes = intervalMinutes
  ): Promise<WritingCoachStatus> {
    if (this.running) throw new Error("Wait for the current writing-coach check to finish before starting a new session.");
    const path = normalizePath(targetPath);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.extension !== "md") throw new Error(`Writing note not found: ${path}`);
    if (!goals.trim()) throw new Error("Writing goals cannot be empty.");
    if (
      !Number.isFinite(intervalMinutes)
      || !Number.isFinite(intervalMaxMinutes)
      || intervalMinutes < 1
      || intervalMaxMinutes > 120
      || intervalMaxMinutes < intervalMinutes
    ) {
      throw new Error("Writing-coach intervals must form a 1–120 minute range whose maximum is not below its minimum.");
    }
    const content = await this.app.vault.cachedRead(file);
    const now = Date.now();
    const minimum = Math.round(intervalMinutes);
    const maximum = Math.round(intervalMaxMinutes);
    const scheduledIntervalMinutes = chooseWritingCoachInterval(minimum, maximum);
    this.session = {
      active: true,
      targetPath: file.path,
      goals: goals.trim(),
      intervalMinutes: minimum,
      intervalMaxMinutes: maximum,
      scheduledIntervalMinutes,
      nextCheckAt: new Date(now + scheduledIntervalMinutes * 60_000).toISOString(),
      checks: 0,
      lastPillar: null,
      pillarBag: shuffledPillars(),
      lastHash: hash(content),
      citation: this.citation(),
      log: ""
    };
    await this.persist();
    this.schedule();
    return this.publicStatus(this.session);
  }

  async stop(): Promise<WritingCoachStatus> {
    if (!this.session) throw new Error("No writing-coach session exists.");
    this.session.active = false;
    this.clearTimer();
    this.controller?.abort();
    await this.persist();
    return this.publicStatus(this.session);
  }

  async checkNow(signal?: AbortSignal): Promise<{ pillar: WritingPillar; feedback: string; status: WritingCoachStatus }> {
    if (!this.session?.active) throw new Error("No active writing-coach session.");
    return this.check(true, signal);
  }

  touch(path: string): void {
    if (!this.session?.active || normalizePath(path) !== this.session.targetPath) return;
    if (new Date(this.session.nextCheckAt).getTime() <= Date.now()) this.schedule(250);
  }

  async renameTarget(oldPath: string, newPath: string): Promise<void> {
    if (!this.session || normalizePath(oldPath) !== this.session.targetPath) return;
    this.session.targetPath = normalizePath(newPath);
    await this.persist();
  }

  async removeTarget(path: string): Promise<void> {
    if (!this.session || normalizePath(path) !== this.session.targetPath) return;
    this.session.active = false;
    this.clearTimer();
    this.controller?.abort();
    await this.persist();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.controller?.abort();
    this.controller = null;
  }

  private async check(
    force: boolean,
    signal?: AbortSignal
  ): Promise<{ pillar: WritingPillar; feedback: string; status: WritingCoachStatus }> {
    throwIfAborted(signal);
    if (!this.session?.active) throw new Error("No active writing-coach session.");
    if (this.running) throw new Error("A writing-coach check is already running.");
    const session = this.session;
    const file = this.app.vault.getAbstractFileByPath(session.targetPath);
    if (!(file instanceof TFile)) throw new Error(`Writing note not found: ${session.targetPath}`);
    const content = await this.app.vault.cachedRead(file);
    throwIfAborted(signal);
    const contentHash = hash(content);
    if (!force && contentHash === session.lastHash) {
      await this.reschedule();
      throw new Error("The draft has not changed since the previous writing-coach check.");
    }

    this.running = true;
    this.controller = new AbortController();
    const onAbort = (): void => this.controller?.abort();
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (session.pillarBag.length === 0) session.pillarBag = shuffledPillars();
      const pillar = session.pillarBag[0]!;
      const result = await this.openRouter.streamChatCompletion(
        this.model(),
        [{
          role: "system",
          content: [
            "You are a continual writing coach.",
            `Evaluate only this pillar: ${pillar}.`,
            "Return under 90 words in Markdown: a short pillar label, one observation grounded in the draft, and one concrete next action.",
            "If the draft is barely started—empty apart from headings, a fragment, or roughly one opening sentence—prioritize momentum: explicitly tell the writer to continue writing, give one small pillar-relevant hint or question, and do not judge unfinished structure.",
            "Do not give a full review, rewrite the draft, or discuss another pillar."
          ].join("\n")
        }, {
          role: "user",
          content: `Writing goals:\n${session.goals}\n\nCurrent draft:\n${draftContext(content)}`
        }],
        [],
        () => undefined,
        this.controller.signal
      );
      const feedback = result.content.trim();
      if (!feedback) throw new Error("The writing coach returned no feedback.");
      if (!session.active || this.session !== session) throw new Error("The writing-coach session stopped during its check.");
      session.pillarBag.shift();
      session.lastHash = contentHash;
      session.lastPillar = pillar;
      session.checks += 1;
      session.log = [
        session.log.trim(),
        `### ${new Date().toLocaleString()} — ${pillar}`,
        "",
        feedback
      ].filter(Boolean).join("\n\n");
      await this.reschedule();
      const status = this.publicStatus(session);
      this.onNudge(pillar, feedback, status);
      return { pillar, feedback, status };
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.running = false;
      this.controller = null;
    }
  }

  private schedule(delay?: number): void {
    this.clearTimer();
    if (!this.session?.active || this.disposed) return;
    const due = Math.max(250, delay ?? new Date(this.session.nextCheckAt).getTime() - Date.now());
    this.timer = window.setTimeout(() => {
      this.timer = null;
      if (!this.session?.active || this.disposed) return;
      if (this.app.workspace.getActiveFile()?.path !== this.session.targetPath) {
        void this.reschedule().catch(this.onError);
        return;
      }
      void this.check(false).catch((error) => {
        if (!/has not changed/i.test(error instanceof Error ? error.message : String(error))) {
          this.onError(error);
          if (this.session?.active) void this.reschedule().catch(this.onError);
        }
      });
    }, due);
  }

  private async reschedule(): Promise<void> {
    if (!this.session) return;
    this.session.scheduledIntervalMinutes = chooseWritingCoachInterval(
      this.session.intervalMinutes,
      this.session.intervalMaxMinutes
    );
    this.session.nextCheckAt = new Date(
      Date.now() + this.session.scheduledIntervalMinutes * 60_000
    ).toISOString();
    await this.persist();
    this.schedule();
  }

  private async persist(): Promise<void> {
    if (!this.session) return;
    const path = this.sessionPath();
    const markdown = [
      "---",
      "type: writing-coach-session",
      "schema: 1",
      `active: ${this.session.active}`,
      `target: ${JSON.stringify(this.session.targetPath)}`,
      `goals: ${JSON.stringify(this.session.goals)}`,
      `interval_minutes: ${this.session.intervalMinutes}`,
      `interval_max_minutes: ${this.session.intervalMaxMinutes}`,
      `scheduled_interval_minutes: ${this.session.scheduledIntervalMinutes}`,
      `next_check_at: ${JSON.stringify(this.session.nextCheckAt)}`,
      `checks: ${this.session.checks}`,
      `last_pillar: ${JSON.stringify(this.session.lastPillar ?? "")}`,
      `pillar_bag: ${JSON.stringify(this.session.pillarBag)}`,
      `last_hash: ${JSON.stringify(this.session.lastHash)}`,
      "---",
      "",
      "# Continual writing coach",
      "",
      `- Draft: [[${this.session.targetPath.replace(/\.md$/i, "")}]]`,
      `- Goals: ${this.session.goals}`,
      `- Interval: ${this.intervalLabel(this.session)}`,
      `- Next interval: ${this.session.scheduledIntervalMinutes} minutes`,
      "",
      "## Feedback log",
      "",
      this.session.log,
      ""
    ].join("\n");
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.app.vault.modify(existing, markdown);
    else await this.app.vault.create(path, markdown);
  }

  private async load(): Promise<WritingCoachSession | null> {
    const file = this.app.vault.getAbstractFileByPath(this.sessionPath());
    if (!(file instanceof TFile)) return null;
    const markdown = await this.app.vault.cachedRead(file);
    const match = markdown.match(FRONTMATTER);
    if (!match) return null;
    const row = (parseYaml(match[1]) ?? {}) as Record<string, unknown>;
    if (row.type !== "writing-coach-session") return null;
    const rawBag = Array.isArray(row.pillar_bag)
      ? row.pillar_bag.filter((value): value is WritingPillar => PILLARS.includes(value as WritingPillar))
      : [];
    const intervalMinutes = Math.min(120, Math.max(1, Math.round(number(row.interval_minutes, 10))));
    const intervalMaxMinutes = Math.min(120, Math.max(
      intervalMinutes,
      Math.round(number(row.interval_max_minutes, intervalMinutes))
    ));
    const scheduledIntervalMinutes = Math.min(intervalMaxMinutes, Math.max(
      intervalMinutes,
      Math.round(number(row.scheduled_interval_minutes, intervalMinutes))
    ));
    return {
      active: row.active === true,
      targetPath: string(row.target),
      goals: string(row.goals),
      intervalMinutes,
      intervalMaxMinutes,
      scheduledIntervalMinutes,
      nextCheckAt: string(row.next_check_at) || new Date(Date.now() + 10 * 60_000).toISOString(),
      checks: Math.max(0, Math.floor(number(row.checks, 0))),
      lastPillar: PILLARS.includes(row.last_pillar as WritingPillar) ? row.last_pillar as WritingPillar : null,
      pillarBag: rawBag.length ? rawBag : shuffledPillars(),
      lastHash: string(row.last_hash),
      citation: this.citation(),
      log: markdown.split(/^## Feedback log\s*$/m)[1]?.trim() ?? ""
    };
  }

  private publicStatus(session: WritingCoachSession): WritingCoachStatus {
    return {
      active: session.active,
      targetPath: session.targetPath,
      goals: session.goals,
      intervalMinutes: session.intervalMinutes,
      intervalMaxMinutes: session.intervalMaxMinutes,
      scheduledIntervalMinutes: session.scheduledIntervalMinutes,
      nextCheckAt: session.nextCheckAt,
      checks: session.checks,
      lastPillar: session.lastPillar,
      citation: session.citation
    };
  }

  private sessionPath(): string {
    return normalizePath(`${this.root()}/Coaching/writing-session.md`);
  }

  private citation(): string {
    return `[[${this.sessionPath().replace(/\.md$/i, "")}]]`;
  }

  private intervalLabel(session: WritingCoachSession): string {
    return session.intervalMinutes === session.intervalMaxMinutes
      ? `${session.intervalMinutes} minutes`
      : `${session.intervalMinutes}–${session.intervalMaxMinutes} minutes`;
  }

  private clearTimer(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
  }
}
