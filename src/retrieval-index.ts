import type { App, TFile } from "obsidian";
import type { SensitiveContentGuard } from "./sensitive-content";
import type { OmnisearchProvider } from "./omnisearch-provider";

export interface RetrievalResult {
  path: string;
  heading: string | null;
  lineStart: number;
  lineEnd: number;
  excerpt: string;
  score: number;
  citation: string;
}

interface IndexedChunk extends RetrievalResult {
  tokens: string[];
}

const tokenize = (value: string): string[] =>
  (value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []);

const normalizePath = (value: string): string =>
  value.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");

export class VaultRetrievalIndex {
  private readonly chunksByPath = new Map<string, IndexedChunk[]>();
  private readonly sensitivePaths = new Set<string>();
  private ready = false;

  constructor(
    private readonly app: App,
    private readonly getExcludedPaths: () => string[],
    private readonly sensitiveGuard: SensitiveContentGuard,
    private readonly omnisearchProvider?: OmnisearchProvider
  ) {}

  async initialize(): Promise<void> {
    this.chunksByPath.clear();
    this.sensitivePaths.clear();
    for (const file of this.app.vault.getMarkdownFiles()) await this.update(file);
    this.ready = true;
  }

  async update(file: TFile): Promise<void> {
    this.remove(file.path);
    if (file.extension !== "md" || this.isExcluded(file.path)) return;
    const content = await this.app.vault.cachedRead(file);
    if (this.sensitiveGuard.inspectFile(file, content).sensitive) {
      this.sensitivePaths.add(file.path);
      return;
    }
    this.chunksByPath.set(file.path, this.chunkFile(file, content));
  }

  remove(path: string): void {
    this.chunksByPath.delete(normalizePath(path));
    this.sensitivePaths.delete(normalizePath(path));
  }

  async search(query: string, limit = 8): Promise<{
    results: RetrievalResult[];
    indexedNotes: number;
    skippedSensitiveNotes: number;
  }> {
    const omnisearch = await this.omnisearchProvider?.search(query, limit);
    if (omnisearch) {
      return {
        results: omnisearch.results,
        indexedNotes: this.chunksByPath.size,
        skippedSensitiveNotes: omnisearch.skippedSensitiveNotes
      };
    }
    if (!this.ready) await this.initialize();
    const queryTokens = [...new Set(tokenize(query))];
    if (queryTokens.length === 0) {
      return {
        results: [],
        indexedNotes: this.chunksByPath.size,
        skippedSensitiveNotes: this.sensitivePaths.size
      };
    }
    const chunks = [...this.chunksByPath.values()].flat();
    const documentFrequency = new Map<string, number>();
    for (const token of queryTokens) {
      documentFrequency.set(token, chunks.filter((chunk) => chunk.tokens.includes(token)).length);
    }
    const scored = chunks.map((chunk) => {
      const frequencies = new Map<string, number>();
      for (const token of chunk.tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
      let score = 0;
      for (const token of queryTokens) {
        const frequency = frequencies.get(token) ?? 0;
        if (frequency === 0) continue;
        const idf = Math.log(1 + (chunks.length + 1) / ((documentFrequency.get(token) ?? 0) + 1));
        score += (frequency / (frequency + 1.2)) * idf;
      }
      return { chunk, score };
    }).filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.min(Math.max(Math.floor(limit), 1), 20));
    return {
      results: scored.map(({ chunk, score }) => ({
        path: chunk.path,
        heading: chunk.heading,
        lineStart: chunk.lineStart,
        lineEnd: chunk.lineEnd,
        excerpt: chunk.excerpt,
        score: Number(score.toFixed(4)),
        citation: chunk.citation
      })),
      indexedNotes: this.chunksByPath.size,
      skippedSensitiveNotes: this.sensitivePaths.size
    };
  }

  getStatus(): {
    ready: boolean;
    indexedNotes: number;
    chunks: number;
    sensitiveNotes: number;
    lexicalProvider: "omnisearch" | "builtin";
    omnisearch: { enabled: boolean; available: boolean; active: boolean };
  } {
    const omnisearch = this.omnisearchProvider?.getStatus()
      ?? { enabled: false, available: false, active: false };
    return {
      ready: this.ready,
      indexedNotes: this.chunksByPath.size,
      chunks: [...this.chunksByPath.values()].reduce((total, chunks) => total + chunks.length, 0),
      sensitiveNotes: this.sensitivePaths.size,
      lexicalProvider: omnisearch.active ? "omnisearch" : "builtin",
      omnisearch
    };
  }

  private chunkFile(file: TFile, content: string): IndexedChunk[] {
    const lines = content.split(/\r?\n/);
    const chunks: IndexedChunk[] = [];
    let heading: string | null = null;
    let start = 0;
    let buffer: string[] = [];
    const flush = (end: number) => {
      const excerpt = buffer.join("\n").trim();
      if (!excerpt) {
        buffer = [];
        start = end + 1;
        return;
      }
      const target = file.path.replace(/\.md$/, "");
      chunks.push({
        path: file.path,
        heading,
        lineStart: start + 1,
        lineEnd: end + 1,
        excerpt,
        score: 0,
        citation: `[[${target}${heading ? `#${heading}` : ""}]]`,
        tokens: tokenize(`${heading ?? ""} ${excerpt}`)
      });
      buffer = [];
      start = end + 1;
    };
    for (let index = 0; index < lines.length; index += 1) {
      const headingMatch = lines[index].match(/^#{1,6}\s+(.+?)\s*#*$/);
      if (headingMatch) {
        if (buffer.length > 0) flush(index - 1);
        heading = headingMatch[1];
        start = index;
      }
      buffer.push(lines[index]);
      if (buffer.join("\n").length >= 1_400 || (lines[index].trim() === "" && buffer.join("\n").length >= 700)) {
        flush(index);
      }
    }
    if (buffer.length > 0) flush(lines.length - 1);
    return chunks;
  }

  private isExcluded(path: string): boolean {
    const normalized = normalizePath(path).replace(/^\/+|\/+$/g, "");
    return this.getExcludedPaths().some((excludedPath) => {
      const excluded = normalizePath(excludedPath).replace(/^\/+|\/+$/g, "");
      return Boolean(excluded) && (normalized === excluded || normalized.startsWith(`${excluded}/`));
    });
  }
}
