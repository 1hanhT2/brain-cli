import { normalizePath, TFile, type App } from "obsidian";
import { isVaultPathSafe } from "./permissions";
import { SensitiveContentGuard, type SensitivityReport } from "./sensitive-content";
import { ensureFolders, type LayoutPathKind } from "./folder-layout";
import type { OmnisearchProvider } from "./omnisearch-provider";

export interface NoteSearchResult {
  matches: Array<{ path: string; excerpt: string; citation: string }>;
  skippedSensitive: number;
}

export class VaultTools {
  constructor(
    private readonly app: App,
    private readonly getExcludedPaths: () => string[],
    private readonly sensitiveGuard: SensitiveContentGuard,
    private readonly omnisearchProvider?: OmnisearchProvider
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

  async readMarkdown(path: string, allowSensitive = false): Promise<string> {
    const file = this.requireFile(path);
    const content = await this.app.vault.cachedRead(file);
    const sensitivity = this.sensitiveGuard.inspectFile(file, content);
    if (sensitivity.sensitive && !allowSensitive) {
      throw new Error(`Sensitive note approval required: ${sensitivity.reasons.join("; ")}`);
    }
    if (content.length > 100_000) {
      return `${content.slice(0, 100_000)}\n\n[Brain CLI truncated this note at 100,000 characters.]`;
    }
    return content;
  }

  async searchMarkdown(query: string, limit = 20): Promise<NoteSearchResult> {
    const omnisearch = await this.omnisearchProvider?.search(query, limit);
    if (omnisearch) {
      return {
        matches: omnisearch.results.map((result) => ({
          path: result.path,
          excerpt: result.excerpt,
          citation: result.citation
        })),
        skippedSensitive: omnisearch.skippedSensitiveNotes
      };
    }
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return { matches: [], skippedSensitive: 0 };
    const results: NoteSearchResult["matches"] = [];
    let skippedSensitive = 0;
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (this.isExcluded(file.path)) continue;
      const content = await this.app.vault.cachedRead(file);
      const index = content.toLocaleLowerCase().indexOf(needle);
      if (index < 0) continue;
      if (this.sensitiveGuard.inspectFile(file, content).sensitive) {
        skippedSensitive += 1;
        continue;
      }
      results.push({
        path: file.path,
        excerpt: content.slice(Math.max(0, index - 100), index + needle.length + 180).replace(/\s+/g, " "),
        citation: `[[${file.path.replace(/\.md$/, "")}]]`
      });
      if (results.length >= limit) break;
    }
    return { matches: results, skippedSensitive };
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

  async restoreFrontmatter(path: string, snapshot: Record<string, unknown>, keys: string[]): Promise<void> {
    const file = this.requireFile(path);
    const safeKeys = keys.filter((key) => !["__proto__", "prototype", "constructor"].includes(key));
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      for (const key of safeKeys) delete frontmatter[key];
      for (const key of safeKeys) {
        if (Object.prototype.hasOwnProperty.call(snapshot, key)) frontmatter[key] = snapshot[key];
      }
    });
  }

  async replaceMarkdown(path: string, content: string): Promise<void> {
    const file = this.requireFile(path);
    await this.app.vault.modify(file, content);
  }

  async appendMarkdown(path: string, content: string): Promise<void> {
    const file = this.requireFile(path);
    await this.app.vault.modify(file, `${await this.app.vault.cachedRead(file)}${content}`);
  }

  async applyPatch(path: string, oldText: string, newText: string, replaceAll = false): Promise<{ replacements: number }> {
    const file = this.requireFile(path);
    const content = await this.app.vault.cachedRead(file);
    if (!oldText) throw new Error("Patch old_text cannot be empty.");
    const occurrences = content.split(oldText).length - 1;
    if (occurrences === 0) throw new Error("The exact old_text was not found in the note.");
    if (occurrences > 1 && !replaceAll) {
      throw new Error(`The exact old_text occurs ${occurrences} times; set replace_all=true or provide more context.`);
    }
    const updated = replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText);
    await this.app.vault.modify(file, updated);
    return { replacements: replaceAll ? occurrences : 1 };
  }

  async previewPatch(path: string, oldText: string, newText: string, replaceAll = false): Promise<{
    before: string;
    after: string;
    occurrences: number;
  }> {
    const file = this.requireFile(path);
    const content = await this.app.vault.cachedRead(file);
    if (!oldText) throw new Error("Patch old_text cannot be empty.");
    const occurrences = content.split(oldText).length - 1;
    if (occurrences === 0) throw new Error("The exact old_text was not found in the note.");
    if (occurrences > 1 && !replaceAll) {
      throw new Error(`The exact old_text occurs ${occurrences} times; provide more context.`);
    }
    return { before: oldText, after: newText, occurrences };
  }

  async renameMarkdown(path: string, newName: string): Promise<{ from: string; to: string }> {
    if (newName.includes("/") || newName.includes("\\")) throw new Error("new_name must be a filename, not a path.");
    const file = this.requireFile(path);
    const filename = newName.toLocaleLowerCase().endsWith(".md") ? newName : `${newName}.md`;
    const parent = file.parent?.path ?? "";
    return this.moveFile(file, normalizePath([parent, filename].filter(Boolean).join("/")));
  }

  async moveMarkdown(path: string, destination: string): Promise<{ from: string; to: string }> {
    const file = this.requireFile(path);
    const normalized = normalizePath(destination);
    if (!normalized.toLocaleLowerCase().endsWith(".md")) throw new Error("destination must end in .md.");
    return this.moveFile(file, normalized);
  }

  async trashMarkdown(path: string): Promise<{ path: string; trashed: true }> {
    const file = this.requireFile(path);
    const originalPath = file.path;
    await this.app.vault.trash(file, false);
    return { path: originalPath, trashed: true };
  }

  async inspectSensitivity(path: string): Promise<SensitivityReport> {
    const file = this.requireFile(path);
    return this.sensitiveGuard.inspectFile(file, await this.app.vault.cachedRead(file));
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
    const paths: string[] = [];
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      paths.push(current);
    }
    await ensureFolders({
      getPathKind: async (candidate): Promise<LayoutPathKind> => {
        const indexed = this.app.vault.getAbstractFileByPath(candidate);
        if (indexed) return indexed instanceof TFile ? "file" : "folder";
        return (await this.app.vault.adapter.stat(candidate))?.type ?? null;
      },
      createFolder: async (candidate) => {
        await this.app.vault.createFolder(candidate);
      }
    }, paths);
  }

  private async moveFile(file: TFile, destination: string): Promise<{ from: string; to: string }> {
    if (!isVaultPathSafe(destination)) throw new Error("Destination is outside the permitted vault area.");
    if (this.isExcluded(destination)) throw new Error(`The destination is excluded from agent access: ${destination}`);
    if (this.app.vault.getAbstractFileByPath(destination)) throw new Error(`A file already exists at ${destination}.`);
    const parent = destination.split("/").slice(0, -1).join("/");
    if (parent) await this.ensureFolder(parent);
    const from = file.path;
    await this.app.fileManager.renameFile(file, destination);
    return { from, to: destination };
  }
}
