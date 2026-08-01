import { normalizePath, parseYaml, TFile, type App } from "obsidian";
import type { MemoryFragment } from "./types";
import { isMemoryFrontmatter, isMemoryMarkdownPath } from "./memory-policy";

export interface StoredMemory extends MemoryFragment {
  path: string;
  citation: string;
}

export interface MemoryInput {
  category: MemoryFragment["category"];
  content: string;
  confidence: number;
  sensitivity?: MemoryFragment["sensitivity"];
  source: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const categories = new Set<MemoryFragment["category"]>([
  "ability", "habit", "preference", "goal", "workflow", "other"
]);

const uniqueId = (): string => typeof crypto?.randomUUID === "function"
  ? crypto.randomUUID()
  : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const number = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

export class MemoryService {
  constructor(private readonly app: App, private readonly root: () => string) {}

  async create(input: MemoryInput): Promise<StoredMemory> {
    const content = input.content.trim();
    if (!content) throw new Error("Memory content cannot be empty.");
    if (content.length > 2_000) throw new Error("Memory content must be 2,000 characters or less.");
    if (!categories.has(input.category)) throw new Error("Memory category is invalid.");
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
      throw new Error("Memory confidence must be between 0 and 1.");
    }
    const id = uniqueId();
    const createdAt = new Date().toISOString();
    const sensitivity = input.sensitivity === "review" ? "review" : "low";
    const path = normalizePath(`${this.root()}/Memory/${id}.md`);
    const fragment: StoredMemory = {
      id,
      category: input.category,
      content,
      confidence: input.confidence,
      sensitivity,
      createdAt,
      source: input.source.trim() || "Brain",
      status: "active",
      path,
      citation: `[[${path.replace(/\.md$/i, "")}]]`
    };
    const markdown = [
      "---",
      `id: ${JSON.stringify(fragment.id)}`,
      "type: memory",
      `category: ${fragment.category}`,
      `confidence: ${fragment.confidence}`,
      `sensitivity: ${fragment.sensitivity}`,
      `created: ${JSON.stringify(fragment.createdAt)}`,
      `source: ${JSON.stringify(fragment.source)}`,
      "status: active",
      "---",
      "",
      fragment.content,
      ""
    ].join("\n");
    await this.app.vault.create(path, markdown);
    return fragment;
  }

  async list(status?: MemoryFragment["status"]): Promise<StoredMemory[]> {
    const prefix = normalizePath(`${this.root()}/Memory`);
    const fragments = await Promise.all(this.app.vault.getMarkdownFiles()
      .filter((file) => file.path.startsWith(`${prefix}/`))
      .map((file) => this.read(file)));
    return fragments
      .filter((fragment): fragment is StoredMemory => fragment !== null)
      .filter((fragment) => !status || fragment.status === status)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async search(query: string, limit = 5, includeReview = false): Promise<StoredMemory[]> {
    const terms = query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
    if (terms.length === 0) return [];
    return (await this.list())
      .filter((fragment) => fragment.status === "active" && (includeReview || fragment.sensitivity === "low"))
      .map((fragment) => {
        const haystack = `${fragment.category} ${fragment.content}`.toLocaleLowerCase();
        const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
        return { fragment, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || right.fragment.confidence - left.fragment.confidence)
      .slice(0, Math.min(Math.max(Math.floor(limit), 1), 10))
      .map((entry) => entry.fragment);
  }

  async contextFor(query: string): Promise<string | null> {
    const fragments = await this.search(query, 4, false);
    if (fragments.length === 0) return null;
    return [
      "[Relevant durable memory — use only when it helps answer the current request]",
      ...fragments.map((fragment) => `- (${fragment.category}, ${Math.round(fragment.confidence * 100)}%) ${fragment.content} ${fragment.citation}`),
      "Do not claim these memories are newly observed facts; correct or supersede them when the user provides newer information."
    ].join("\n");
  }

  async setStatus(path: string, status: MemoryFragment["status"]): Promise<StoredMemory> {
    if (!["active", "superseded", "revoked"].includes(status)) throw new Error("Memory status is invalid.");
    const normalized = normalizePath(path);
    const memoryRoot = normalizePath(`${this.root()}/Memory`);
    if (!isMemoryMarkdownPath(normalized, memoryRoot)) {
      throw new Error(`Memory must be a Markdown file inside ${memoryRoot}.`);
    }
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (!(file instanceof TFile)) throw new Error(`Memory not found: ${path}`);
    if (!await this.read(file)) throw new Error(`Memory not found: ${path}`);
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      if (!isMemoryFrontmatter(frontmatter)) throw new Error(`Memory not found: ${path}`);
      frontmatter.status = status;
    });
    const updated = await this.read(file);
    if (!updated || updated.status !== status) throw new Error("Memory status could not be verified after writing.");
    return updated;
  }

  private async read(file: TFile): Promise<StoredMemory | null> {
    const markdown = await this.app.vault.read(file);
    const match = markdown.match(FRONTMATTER);
    if (!match) return null;
    let frontmatter: Record<string, unknown>;
    try { frontmatter = parseYaml(match[1]) as Record<string, unknown>; } catch { return null; }
    if (frontmatter.type !== "memory") return null;
    const category = text(frontmatter.category) as MemoryFragment["category"];
    const status = text(frontmatter.status) as MemoryFragment["status"];
    if (!categories.has(category) || !["active", "superseded", "revoked"].includes(status)) return null;
    return {
      id: text(frontmatter.id) || file.basename,
      category,
      content: markdown.slice(match[0].length).trim(),
      confidence: Math.min(1, Math.max(0, number(frontmatter.confidence, 0.5))),
      sensitivity: frontmatter.sensitivity === "review" ? "review" : "low",
      createdAt: text(frontmatter.created) || new Date(file.stat.ctime).toISOString(),
      source: text(frontmatter.source) || "Brain",
      status,
      path: file.path,
      citation: `[[${file.path.replace(/\.md$/i, "")}]]`
    };
  }
}
