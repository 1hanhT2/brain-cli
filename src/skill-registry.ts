import { normalizePath, parseYaml, TFile, type App } from "obsidian";
import { brainPath } from "./data-layout";
import type { BrainSettings } from "./settings";
import { EXP_AGENT_METADATA, EXP_EXAMPLES, EXP_RUBRIC, EXP_SKILL } from "./bundled-exp-skill";
import { ensureFolders, type LayoutPathKind } from "./folder-layout";

export interface SkillMetadata {
  name: string;
  description: string;
  path: string;
  folder: string;
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export class SkillRegistry {
  private skills = new Map<string, SkillMetadata>();

  constructor(
    private readonly app: App,
    private readonly getSettings: () => BrainSettings
  ) {}

  async initialize(): Promise<void> {
    await this.ensureBundledExpSkill();
    await this.refresh();
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
    if (!/^[a-z0-9-]{1,63}$/.test(name)) throw new Error("Skill name must use lowercase letters, digits, and hyphens.");
    if (!description) throw new Error("Skill description is required.");
    return {
      name,
      description,
      path: file.path,
      folder: file.parent?.path ?? ""
    };
  }

  private async ensureBundledExpSkill(): Promise<void> {
    const root = brainPath(this.getSettings(), "Skills/exp");
    const files = [
      { path: `${root}/SKILL.md`, content: EXP_SKILL },
      { path: `${root}/agents/openai.yaml`, content: EXP_AGENT_METADATA },
      { path: `${root}/references/rubric.md`, content: EXP_RUBRIC },
      { path: `${root}/references/examples.md`, content: EXP_EXAMPLES }
    ];
    for (const entry of files) {
      const existing = await this.getPathKind(entry.path);
      if (existing === "file") continue;
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
