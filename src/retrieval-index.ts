import type { App, TFile } from "obsidian";
import type { SensitiveContentGuard } from "./sensitive-content";
import type { OmnisearchProvider } from "./omnisearch-provider";
import type { SemanticIndexCoordinator } from "./semantic-index";
import { chunkMatchesFilters, normalizeVaultPath, prepareMarkdownChunks, stableHash } from "./markdown-chunks";
import type {
  PreparedChunk,
  RetrievalFilters,
  RetrievalMode,
  ScoredSemanticChunk
} from "./semantic-types";

export interface RetrievalResult {
  chunkId?: string;
  path: string;
  heading: string | null;
  lineStart: number;
  lineEnd: number;
  excerpt: string;
  score: number;
  citation: string;
  sourceEngines?: Array<"lexical" | "semantic">;
  lexicalScore?: number;
  semanticScore?: number;
}

export interface RetrievalSearchOptions extends RetrievalFilters {
  mode?: RetrievalMode;
}

interface IndexedChunk extends PreparedChunk {
  score: number;
  tokens: string[];
}

export interface RankedChunk {
  id: string;
  result: RetrievalResult;
  rank: number;
  engine: "lexical" | "semantic";
  rawScore: number;
}

const tokenize = (value: string): string[] =>
  (value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []);

export const reciprocalRankFusion = (
  lexical: RankedChunk[],
  semantic: RankedChunk[],
  limit: number,
  maxPerNote = 2,
  k = 60
): RetrievalResult[] => {
  const combined = new Map<string, {
    result: RetrievalResult;
    score: number;
    engines: Set<"lexical" | "semantic">;
    lexicalScore?: number;
    semanticScore?: number;
  }>();
  for (const ranked of [...lexical, ...semantic]) {
    const current = combined.get(ranked.id) ?? {
      result: ranked.result,
      score: 0,
      engines: new Set<"lexical" | "semantic">()
    };
    current.score += 1 / (k + ranked.rank);
    current.engines.add(ranked.engine);
    if (ranked.engine === "lexical") current.lexicalScore = ranked.rawScore;
    else current.semanticScore = ranked.rawScore;
    combined.set(ranked.id, current);
  }

  const noteCounts = new Map<string, number>();
  const results: RetrievalResult[] = [];
  for (const entry of [...combined.values()].sort((left, right) => right.score - left.score)) {
    const count = noteCounts.get(entry.result.path) ?? 0;
    if (count >= maxPerNote) continue;
    noteCounts.set(entry.result.path, count + 1);
    results.push({
      ...entry.result,
      score: Number(entry.score.toFixed(6)),
      sourceEngines: [...entry.engines],
      lexicalScore: entry.lexicalScore,
      semanticScore: entry.semanticScore
    });
    if (results.length >= limit) break;
  }
  return results;
};

export class VaultRetrievalIndex {
  private readonly chunksByPath = new Map<string, IndexedChunk[]>();
  private readonly sensitivePaths = new Set<string>();
  private ready = false;

  constructor(
    private readonly app: App,
    private readonly getExcludedPaths: () => string[],
    private readonly sensitiveGuard: SensitiveContentGuard,
    private readonly omnisearchProvider?: OmnisearchProvider,
    private readonly semanticIndex?: SemanticIndexCoordinator
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
    const frontmatter = this.app.metadataCache?.getFileCache?.(file)?.frontmatter;
    this.chunksByPath.set(file.path, prepareMarkdownChunks(file, content, frontmatter, false).map((chunk) => ({
      ...chunk,
      score: 0,
      tokens: tokenize(chunk.embeddingText)
    })));
  }

  remove(path: string): void {
    this.chunksByPath.delete(normalizeVaultPath(path));
    this.sensitivePaths.delete(normalizeVaultPath(path));
  }

  async search(
    query: string,
    limit = 8,
    options: RetrievalSearchOptions = {}
  ): Promise<{
    results: RetrievalResult[];
    indexedNotes: number;
    skippedSensitiveNotes: number;
    mode: RetrievalMode;
    fallback: "lexical" | null;
    partial: boolean;
  }> {
    const requestedMode = options.mode ?? "hybrid";
    const cappedLimit = Math.min(Math.max(Math.floor(limit), 1), 20);
    const engineLimit = 30;
    let semanticFailed = false;

    let lexicalSearch = requestedMode === "semantic"
      ? { rows: [], skippedSensitiveNotes: 0 }
      : await this.lexicalSearch(query, engineLimit, options);
    let lexical = lexicalSearch.rows;
    let semantic: RankedChunk[] = [];
    if (requestedMode !== "lexical" && this.semanticIndex?.getStatus().enabled) {
      try {
        semantic = this.semanticRanks(await this.semanticIndex.search(query, options, engineLimit));
      } catch (error) {
        semanticFailed = true;
        console.warn("[Obsidian Brain] Semantic retrieval failed; using lexical fallback.", error);
      }
    } else if (requestedMode !== "lexical") {
      semanticFailed = true;
    }
    if (semanticFailed && lexical.length === 0) {
      lexicalSearch = await this.lexicalSearch(query, engineLimit, options);
      lexical = lexicalSearch.rows;
    }

    const semanticStatus = this.semanticIndex?.getStatus();
    const results = requestedMode === "lexical"
      ? this.diverseResults(lexical, cappedLimit)
      : requestedMode === "semantic" && !semanticFailed
        ? this.diverseResults(semantic, cappedLimit)
        : reciprocalRankFusion(lexical, semantic, cappedLimit);
    return {
      results,
      indexedNotes: this.chunksByPath.size,
      skippedSensitiveNotes: Math.max(
        this.sensitivePaths.size,
        lexicalSearch.skippedSensitiveNotes,
        semanticStatus?.skippedSensitiveNotes ?? 0
      ),
      mode: requestedMode,
      fallback: semanticFailed ? "lexical" : null,
      partial: Boolean(semanticStatus?.partial)
    };
  }

  getStatus(): {
    ready: boolean;
    indexedNotes: number;
    chunks: number;
    sensitiveNotes: number;
    lexicalProvider: "omnisearch" | "builtin";
    omnisearch: { enabled: boolean; available: boolean; active: boolean };
    semantic?: ReturnType<SemanticIndexCoordinator["getStatus"]>;
  } {
    const omnisearch = this.omnisearchProvider?.getStatus()
      ?? { enabled: false, available: false, active: false };
    return {
      ready: this.ready,
      indexedNotes: this.chunksByPath.size,
      chunks: [...this.chunksByPath.values()].reduce((total, chunks) => total + chunks.length, 0),
      sensitiveNotes: this.sensitivePaths.size,
      lexicalProvider: omnisearch.active ? "omnisearch" : "builtin",
      omnisearch,
      semantic: this.semanticIndex?.getStatus()
    };
  }

  private async lexicalSearch(
    query: string,
    limit: number,
    filters: RetrievalFilters
  ): Promise<{ rows: RankedChunk[]; skippedSensitiveNotes: number }> {
    const omnisearch = await this.omnisearchProvider?.search(query, limit);
    if (omnisearch) {
      return {
        skippedSensitiveNotes: omnisearch.skippedSensitiveNotes,
        rows: omnisearch.results.flatMap((result, index): RankedChunk[] => {
        const chunk = this.findChunk(result.path, result.lineStart);
        if (!chunk) {
          if (filters.folders?.length || filters.tags?.length || Object.keys(filters.properties ?? {}).length) return [];
          return [{
            id: stableHash(`${result.path}|${result.lineStart}`),
            result,
            rank: index + 1,
            engine: "lexical" as const,
            rawScore: result.score
          }];
        }
        if (!chunkMatchesFilters(chunk, filters)) return [];
        return [{
          id: chunk.id,
          result: this.resultFromChunk(chunk, result.score),
          rank: index + 1,
          engine: "lexical" as const,
          rawScore: result.score
        }];
        })
      };
    }

    if (!this.ready) await this.initialize();
    const queryTokens = [...new Set(tokenize(query))];
    if (queryTokens.length === 0) return { rows: [], skippedSensitiveNotes: this.sensitivePaths.size };
    const chunks = [...this.chunksByPath.values()].flat().filter((chunk) =>
      chunkMatchesFilters(chunk, filters)
    );
    const documentFrequency = new Map<string, number>();
    for (const token of queryTokens) {
      documentFrequency.set(token, chunks.filter((chunk) => chunk.tokens.includes(token)).length);
    }
    const rows = chunks.map((chunk) => {
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
      .slice(0, limit)
      .map(({ chunk, score }, index) => ({
        id: chunk.id,
        result: this.resultFromChunk(chunk, score),
        rank: index + 1,
        engine: "lexical" as const,
        rawScore: score
      }));
    return { rows, skippedSensitiveNotes: this.sensitivePaths.size };
  }

  private semanticRanks(rows: ScoredSemanticChunk[]): RankedChunk[] {
    return rows.map(({ chunk, score }, index) => ({
      id: chunk.id,
      result: {
        chunkId: chunk.id,
        path: chunk.path,
        heading: chunk.heading,
        lineStart: chunk.lineStart,
        lineEnd: chunk.lineEnd,
        excerpt: chunk.excerpt,
        score,
        citation: chunk.citation,
        semanticScore: score,
        sourceEngines: ["semantic"]
      },
      rank: index + 1,
      engine: "semantic",
      rawScore: score
    }));
  }

  private diverseResults(rows: RankedChunk[], limit: number): RetrievalResult[] {
    const counts = new Map<string, number>();
    const results: RetrievalResult[] = [];
    for (const row of rows) {
      const count = counts.get(row.result.path) ?? 0;
      if (count >= 2) continue;
      counts.set(row.result.path, count + 1);
      results.push({
        ...row.result,
        score: Number(row.rawScore.toFixed(6)),
        sourceEngines: [row.engine],
        ...(row.engine === "lexical" ? { lexicalScore: row.rawScore } : { semanticScore: row.rawScore })
      });
      if (results.length >= limit) break;
    }
    return results;
  }

  private resultFromChunk(chunk: IndexedChunk, score: number): RetrievalResult {
    return {
      chunkId: chunk.id,
      path: chunk.path,
      heading: chunk.heading,
      lineStart: chunk.lineStart,
      lineEnd: chunk.lineEnd,
      excerpt: chunk.excerpt,
      score: Number(score.toFixed(4)),
      citation: chunk.citation
    };
  }

  private findChunk(path: string, line: number): IndexedChunk | undefined {
    const chunks = this.chunksByPath.get(normalizeVaultPath(path)) ?? [];
    return chunks.find((chunk) => line >= chunk.lineStart && line <= chunk.lineEnd)
      ?? chunks.reduce<IndexedChunk | undefined>((closest, chunk) => {
        if (!closest) return chunk;
        return Math.abs(chunk.lineStart - line) < Math.abs(closest.lineStart - line) ? chunk : closest;
      }, undefined);
  }

  private isExcluded(path: string): boolean {
    const normalized = normalizeVaultPath(path);
    return this.getExcludedPaths().some((excludedPath) => {
      const excluded = normalizeVaultPath(excludedPath);
      return Boolean(excluded) && (normalized === excluded || normalized.startsWith(`${excluded}/`));
    });
  }
}
