import { normalizePath, TFile, TFolder, type App } from "obsidian";
import { isVaultPathSafe } from "./permissions";

export class VaultTools {
  constructor(
    private readonly app: App,
    private readonly getExcludedPaths: () => string[]
  ) {}

  getEnvironment(): {
    vault: string;
    activeFile: string | null;
    markdownFiles: number;
    excludedPaths: string[];
  } {
    return {
      vault: this.app.vault.getName(),
      activeFile: this.app.workspace.getActiveFile()?.path ?? null,
      markdownFiles: this.app.vault.getMarkdownFiles().length,
      excludedPaths: this.getExcludedPaths()
    };
  }

  listMarkdown(folder = "", limit = 100): string[] {
    const normalizedFolder = folder.trim()
      ? normalizePath(folder).replace(/^\/+|\/+$/g, "")
      : "";
    const cappedLimit = Math.min(Math.max(Math.floor(limit), 1), 200);
    return this.app.vault.getMarkdownFiles()
      .filter((file) => !this.isExcluded(file.path))
      .filter((file) => !normalizedFolder || file.path === normalizedFolder || file.path.startsWith(`${normalizedFolder}/`))
      .map((file) => file.path)
      .sort((left, right) => left.localeCompare(right))
      .slice(0, cappedLimit);
  }

  async readMarkdown(path: string): Promise<string> {
    const file = this.requireFile(path);
    const content = await this.app.vault.cachedRead(file);
    if (content.length > 100_000) {
      return `${content.slice(0, 100_000)}\n\n[Obsidian Brain truncated this note at 100,000 characters.]`;
    }
    return content;
  }

  async searchMarkdown(query: string, limit = 20): Promise<Array<{ path: string; excerpt: string }>> {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return [];
    const results: Array<{ path: string; excerpt: string }> = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (this.isExcluded(file.path)) continue;
      const content = await this.app.vault.cachedRead(file);
      const index = content.toLocaleLowerCase().indexOf(needle);
      if (index < 0) continue;
      results.push({ path: file.path, excerpt: content.slice(Math.max(0, index - 100), index + needle.length + 180).replace(/\s+/g, " ") });
      if (results.length >= limit) break;
    }
    return results;
  }

  async createMarkdown(path: string, content: string): Promise<TFile> {
    const normalized = normalizePath(path);
    if (!isVaultPathSafe(normalized) || !normalized.endsWith(".md")) throw new Error("Only safe Markdown paths inside the vault are allowed.");
    if (this.isExcluded(normalized)) throw new Error(`The path is excluded from agent access: ${normalized}`);
    if (this.app.vault.getAbstractFileByPath(normalized)) throw new Error(`A file already exists at ${normalized}.`);
    const parent = normalized.split("/").slice(0, -1).join("/");
    if (parent) await this.ensureFolder(parent);
    return this.app.vault.create(normalized, content);
  }

  async updateFrontmatter(path: string, updates: Record<string, unknown>): Promise<void> {
    const file = this.requireFile(path);
    const safeUpdates = Object.fromEntries(
      Object.entries(updates).filter(([key]) => !["__proto__", "prototype", "constructor"].includes(key))
    );
    if (Object.keys(safeUpdates).length === 0) throw new Error("No safe frontmatter fields were provided.");
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => Object.assign(frontmatter, safeUpdates));
  }

  async replaceMarkdown(path: string, content: string): Promise<void> {
    const file = this.requireFile(path);
    await this.app.vault.modify(file, content);
  }

  private requireFile(path: string): TFile {
    const normalized = normalizePath(path);
    if (!isVaultPathSafe(normalized)) throw new Error("Path is outside the permitted vault area.");
    if (this.isExcluded(normalized)) throw new Error(`The path is excluded from agent access: ${normalized}`);
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (!(file instanceof TFile) || file.extension !== "md") throw new Error(`Markdown file not found: ${normalized}`);
    return file;
  }

  private isExcluded(path: string): boolean {
    const normalized = normalizePath(path).replace(/^\/+|\/+$/g, "");
    return this.getExcludedPaths().some((excludedPath) => {
      const excluded = normalizePath(excludedPath).replace(/^\/+|\/+$/g, "");
      return Boolean(excluded) && (normalized === excluded || normalized.startsWith(`${excluded}/`));
    });
  }

  private async ensureFolder(path: string): Promise<void> {
    const segments = normalizePath(path).split("/").filter(Boolean);
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFile) throw new Error(`Cannot create folder because a file exists at ${current}.`);
      if (!existing) await this.app.vault.createFolder(current);
      else if (!(existing instanceof TFolder)) throw new Error(`Invalid folder path: ${current}`);
    }
  }
}
