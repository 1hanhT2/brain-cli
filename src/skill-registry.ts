import { normalizePath, parseYaml, TFile, type App } from "obsidian";
import { brainPath } from "./data-layout";
import type { BrainSettings } from "./settings";
import { EXP_AGENT_METADATA, EXP_EXAMPLES, EXP_RUBRIC, EXP_SCHEMA, EXP_SKILL } from "./bundled-exp-skill";
import { ensureFolders, type LayoutPathKind } from "./folder-layout";
import WRITING_COACH_SKILL from "../skills/continual-writing-coach/SKILL.md";
import WRITING_COACH_PILLARS from "../skills/continual-writing-coach/references/pillars.md";
import WRITING_COACH_AGENT_METADATA from "../skills/continual-writing-coach/agents/openai.yaml";

export interface SkillMetadata {
  name: string;
  description: string;
  path: string;
  folder: string;
  completions: SkillCompletion[];
}

export interface SkillCompletion {
  value: string;
  description: string;
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const EXP_COMPLETIONS: SkillCompletion[] = [
  { value: "status", description: "Show EXP totals, level, and streaks" },
  { value: "check", description: "Reconcile newly completed tasks and process their EXP" },
  { value: "pending", description: "Review pending completion awards" },
  { value: "score-completed", description: "Batch-score completed tasks that need EXP" },
  { value: "history", description: "Browse the EXP ledger" },
  { value: "review", description: "Review scoring consistency" },
  { value: "analytics", description: "Show EXP by tag and project" },
  { value: "goals", description: "Show active EXP goals" },
  { value: "task", description: "Inspect EXP stored on a task" },
  { value: "calibrate", description: "Start rubric-guided calibration" },
  { value: "score", description: "Score a task or described work" }
];
const EXP_COMPLETIONS_YAML = EXP_COMPLETIONS
  .map((completion) => `  - value: ${completion.value}\n    description: ${completion.description}`)
  .join("\n");
const LEGACY_EXP_CREATION_RULE = "When this skill is active and Brain creates a task, propose planned EXP immediately after the task is created. This remains a separate approval. Tasks created directly in TaskNotes are not sent to a model automatically; score them when the user invokes this skill or asks for unscored tasks.";
const CURRENT_EXP_CREATION_RULE = "When this skill is active and Brain creates a task, propose planned EXP immediately after the task is created unless the environment reports that automatic task scoring is enabled. Manual proposals remain separately approved. When automatic task scoring is enabled, newly created non-sensitive TaskNotes are scored by the configured background model and written through the EXP service.";
const BUNDLED_SKILLS_VERSION = 2;
const WRITING_COACH_COMPLETIONS: SkillCompletion[] = [
  { value: "start", description: "Start timed coaching for a writing note" },
  { value: "status", description: "Show the current coaching session" },
  { value: "check", description: "Request one focused writing nudge now" },
  { value: "stop", description: "Stop the current coaching session" }
];

export class SkillRegistry {
  private skills = new Map<string, SkillMetadata>();
  private initialized = false;
  private initialization: Promise<void> | null = null;

  constructor(
    private readonly app: App,
    private readonly getSettings: () => BrainSettings,
    private readonly persistBundledVersion: (version: number) => Promise<void> = async () => undefined
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initialization) return this.initialization;
    this.initialization = (async () => {
      if (this.getSettings().bundledSkillsVersion < BUNDLED_SKILLS_VERSION) {
        await this.ensureBundledSkills();
        this.getSettings().bundledSkillsVersion = BUNDLED_SKILLS_VERSION;
        await this.persistBundledVersion(BUNDLED_SKILLS_VERSION);
      }
      await this.refresh();
      this.initialized = true;
    })();
    try {
      await this.initialization;
    } finally {
      this.initialization = null;
    }
  }

  async refresh(): Promise<SkillMetadata[]> {
    const root = brainPath(this.getSettings(), "Skills");
    const discovered = new Map<string, SkillMetadata>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(`${root}/`) || !file.path.endsWith("/SKILL.md")) continue;
      try {
        const content = await this.app.vault.cachedRead(file);
        const metadata = this.parseMetadata(file, content);
        if (!discovered.has(metadata.name)) discovered.set(metadata.name, metadata);
      } catch (error) {
        console.warn(`[Obsidian Brain] Ignoring invalid skill at ${file.path}.`, error);
      }
    }
    this.skills = discovered;
    return this.list();
  }

  list(): SkillMetadata[] {
    return [...this.skills.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  get(name: string): SkillMetadata | undefined {
    return this.skills.get(name.trim().toLocaleLowerCase());
  }

  async load(name: string): Promise<{ metadata: SkillMetadata; instructions: string }> {
    const metadata = this.get(name);
    if (!metadata) throw new Error(`Skill not found: ${name}`);
    const file = this.app.vault.getAbstractFileByPath(metadata.path);
    if (!(file instanceof TFile)) throw new Error(`Skill file not found: ${metadata.path}`);
    const content = await this.app.vault.cachedRead(file);
    return {
      metadata,
      instructions: content.replace(FRONTMATTER_PATTERN, "").trim()
    };
  }

  async readReference(name: string, relativePath: string): Promise<{ path: string; content: string }> {
    const skill = this.get(name);
    if (!skill) throw new Error(`Skill not found: ${name}`);
    const normalized = normalizePath(`${skill.folder}/${relativePath}`);
    if (!normalized.startsWith(`${skill.folder}/`) || normalized.includes("/../")) {
      throw new Error("Skill reference path escapes the skill folder.");
    }
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (!(file instanceof TFile) || file.extension !== "md") {
      throw new Error(`Skill reference not found: ${relativePath}`);
    }
    return { path: file.path, content: await this.app.vault.cachedRead(file) };
  }

  match(userText: string): SkillMetadata | null {
    const text = userText.toLocaleLowerCase();
    let best: { skill: SkillMetadata; score: number } | null = null;
    for (const skill of this.skills.values()) {
      let score = 0;
      if (text.includes(`$${skill.name}`) || new RegExp(`\\b${escapeRegExp(skill.name)}\\b`, "i").test(text)) score += 5;
      const keywords = skill.description.toLocaleLowerCase()
        .match(/[\p{L}\p{N}-]{4,}/gu)
        ?.filter((word) => !STOP_WORDS.has(word)) ?? [];
      score += [...new Set(keywords)].filter((word) => text.includes(word)).length;
      if (score >= 3 && (!best || score > best.score)) best = { skill, score };
    }
    return best?.skill ?? null;
  }

  catalogPrompt(): string {
    if (this.skills.size === 0) return "No skills are installed.";
    return this.list().map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
  }

  private parseMetadata(file: TFile, content: string): SkillMetadata {
    const match = content.match(FRONTMATTER_PATTERN);
    if (!match) throw new Error("SKILL.md must begin with YAML frontmatter.");
    const frontmatter = parseYaml(match[1]) as Record<string, unknown> | null;
    const name = typeof frontmatter?.name === "string" ? frontmatter.name.trim().toLocaleLowerCase() : "";
    const description = typeof frontmatter?.description === "string" ? frontmatter.description.trim() : "";
    const completions = Array.isArray(frontmatter?.completions)
      ? frontmatter.completions.flatMap((entry) => {
          const row = entry && typeof entry === "object" && !Array.isArray(entry)
            ? entry as Record<string, unknown>
            : {};
          const value = typeof row.value === "string" ? row.value.trim() : "";
          const completionDescription = typeof row.description === "string"
            ? row.description.trim()
            : "";
          return value ? [{ value, description: completionDescription || `Run ${value}` }] : [];
        })
      : [];
    if (!/^[a-z0-9-]{1,63}$/.test(name)) throw new Error("Skill name must use lowercase letters, digits, and hyphens.");
    if (!description) throw new Error("Skill description is required.");
    return {
      name,
      description,
      path: file.path,
      folder: file.parent?.path ?? "",
      completions: completions.length > 0
        ? completions
        : name === "exp" ? EXP_COMPLETIONS
          : name === "continual-writing-coach" ? WRITING_COACH_COMPLETIONS
            : []
    };
  }

  private async ensureBundledSkills(): Promise<void> {
    const expRoot = brainPath(this.getSettings(), "Skills/exp");
    const coachRoot = brainPath(this.getSettings(), "Skills/continual-writing-coach");
    const files = [
      { path: `${expRoot}/SKILL.md`, content: EXP_SKILL },
      { path: `${expRoot}/agents/openai.yaml`, content: EXP_AGENT_METADATA },
      { path: `${expRoot}/references/rubric.md`, content: EXP_RUBRIC },
      { path: `${expRoot}/references/examples.md`, content: EXP_EXAMPLES },
      { path: `${expRoot}/references/schema.md`, content: EXP_SCHEMA },
      { path: `${coachRoot}/SKILL.md`, content: WRITING_COACH_SKILL },
      { path: `${coachRoot}/agents/openai.yaml`, content: WRITING_COACH_AGENT_METADATA },
      { path: `${coachRoot}/references/pillars.md`, content: WRITING_COACH_PILLARS }
    ];
    for (const entry of files) {
      const existing = await this.getPathKind(entry.path);
      if (existing === "file") {
        const file = this.app.vault.getAbstractFileByPath(entry.path);
        if (file instanceof TFile) {
          const content = await this.app.vault.cachedRead(file);
          let migrated = content;
          if (entry.path === `${expRoot}/SKILL.md`) {
            migrated = this.migrateExpSkill(migrated);
          } else if (
            entry.path === `${expRoot}/references/schema.md`
            && !migrated.includes('title: "[EXP] Task title"')
          ) {
            migrated = migrated.replace(
              "The task note stores its current EXP state in flat frontmatter:\n",
              'The task note stores its current EXP state in flat frontmatter:\n\n- `title: "[EXP] Task title"` (existing numeric prefixes are replaced)\n'
            );
          }
          if (entry.path === `${expRoot}/references/schema.md`) {
            migrated = migrated.replace("- `exp_schema: 1`", "- `exp_schema: 2`");
            if (!migrated.includes("exp_task_id")) {
              migrated = migrated.replace(
                "- `exp_revision: positive integer`",
                [
                  "- `exp_revision: positive integer`",
                  "- `exp_task_id: stable task identifier`",
                  "- `exp_last_completion_id: most recently awarded completion or null`"
                ].join("\n")
              );
              migrated = migrated.replace(
                "Totals and streaks count only events whose action is `award`.",
                "Version 2 award events can include completion identity, model, usage, cost, and rubric metadata.\nTotals and streaks count only events whose action is `award`."
              );
            }
          }
          if (migrated !== content) await this.app.vault.modify(file, migrated);
        }
        continue;
      }
      if (existing === "folder") throw new Error(`Cannot create bundled skill file because a folder exists at ${entry.path}.`);
      await this.ensureFolder(entry.path.split("/").slice(0, -1).join("/"));
      try {
        await this.app.vault.create(entry.path, entry.content);
      } catch (error) {
        if (await this.getPathKind(entry.path) === "file") continue;
        throw error;
      }
    }
  }

  private migrateExpSkill(content: string): string {
    let migrated = content.replace(LEGACY_EXP_CREATION_RULE, CURRENT_EXP_CREATION_RULE);
    const frontmatter = migrated.match(FRONTMATTER_PATTERN)?.[0] ?? "";
    if (frontmatter && !/\ncompletions:\s*\n/.test(frontmatter)) {
      const expanded = frontmatter.replace(/\r?\n---\r?\n?$/, `\ncompletions:\n${EXP_COMPLETIONS_YAML}\n---\n`);
      migrated = `${expanded}${migrated.slice(frontmatter.length)}`;
    } else if (frontmatter && !frontmatter.includes("value: check")) {
      const additions = [
        "  - value: check",
        "    description: Reconcile completed tasks and process their EXP",
        "  - value: pending",
        "    description: Review pending completion awards",
        "  - value: score-completed",
        "    description: Batch-score completed tasks that need EXP"
      ].join("\n");
      const expanded = frontmatter.replace(/\r?\n---\r?\n?$/, `\n${additions}\n---\n`);
      migrated = `${expanded}${migrated.slice(frontmatter.length)}`;
    }
    const currentFrontmatter = migrated.match(FRONTMATTER_PATTERN)?.[0] ?? "";
    if (currentFrontmatter && !currentFrontmatter.includes("value: analytics")) {
      const additions = [
        "  - value: analytics",
        "    description: Show EXP by tag and project",
        "  - value: goals",
        "    description: Show active EXP goals"
      ].join("\n");
      const expanded = currentFrontmatter.replace(/\r?\n---\r?\n?$/, `\n${additions}\n---\n`);
      migrated = `${expanded}${migrated.slice(currentFrontmatter.length)}`;
    }
    const latestFrontmatter = migrated.match(FRONTMATTER_PATTERN)?.[0] ?? "";
    if (latestFrontmatter && !latestFrontmatter.includes("value: score-completed")) {
      const additions = [
        "  - value: score-completed",
        "    description: Batch-score completed tasks that need EXP"
      ].join("\n");
      const expanded = latestFrontmatter.replace(/\r?\n---\r?\n?$/, `\n${additions}\n---\n`);
      migrated = `${expanded}${migrated.slice(latestFrontmatter.length)}`;
    }
    return migrated;
  }

  private async ensureFolder(path: string): Promise<void> {
    const segments = normalizePath(path).split("/").filter(Boolean);
    let current = "";
    const paths: string[] = [];
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      paths.push(current);
    }
    await ensureFolders({
      getPathKind: (candidate) => this.getPathKind(candidate),
      createFolder: async (candidate) => {
        await this.app.vault.createFolder(candidate);
      }
    }, paths);
  }

  private async getPathKind(path: string): Promise<LayoutPathKind> {
    const indexed = this.app.vault.getAbstractFileByPath(path);
    if (indexed) return indexed instanceof TFile ? "file" : "folder";
    return (await this.app.vault.adapter.stat(path))?.type ?? null;
  }
}

const STOP_WORDS = new Set([
  "with", "based", "when", "this", "that", "from", "into", "work", "use", "using",
  "task", "tasks", "completed", "planned", "progress", "fields"
]);

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
