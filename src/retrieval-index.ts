import type { App, TFile } from "obsidian";
import type { SensitiveContentGuard } from "./sensitive-content";
import type { OmnisearchProvider } from "./omnisearch-provider";
import type { SemanticIndexCoordinator } from "./semantic-index";
import type { PerformanceTracer } from "./performance";
import {
  MemoryLexicalIndexStore,
  type LexicalIndexRecord,
  type LexicalIndexStore
} from "./retrieval-store";
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

const LEXICAL_INDEX_VERSION = 1;

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
  private readonly recordsByPath = new Map<string, LexicalIndexRecord>();
  private readonly sensitivePaths = new Set<string>();
  private ready = false;
  private builtinReady = false;
  private initialization: Promise<void> | null = null;
  private initializationStats = { restoredNotes: 0, updatedNotes: 0, removedNotes: 0, skippedForOmnisearch: false };

  constructor(
    private readonly app: App,
    private readonly getExcludedPaths: () => string[],
    private readonly sensitiveGuard: SensitiveContentGuard,
    private readonly omnisearchProvider?: OmnisearchProvider,
    private readonly semanticIndex?: SemanticIndexCoordinator,
    private readonly store: LexicalIndexStore = new MemoryLexicalIndexStore(),
    private readonly performance?: PerformanceTracer
  ) {}

  async initialize(): Promise<void> {
    if (this.omnisearchProvider?.getStatus().active) {
      this.chunksByPath.clear();
      this.recordsByPath.clear();
      this.sensitivePaths.clear();
      this.ready = true;
      this.builtinReady = false;
      this.initializationStats = {
        restoredNotes: 0,
        updatedNotes: 0,
        removedNotes: 0,
        skippedForOmnisearch: true
      };
      return;
    }
    await this.ensureBuiltinIndex();
  }

  async rebuild(): Promise<void> {
    await this.store.clear();
    this.chunksByPath.clear();
    this.recordsByPath.clear();
    this.sensitivePaths.clear();
    this.ready = false;
    this.builtinReady = false;
    await this.ensureBuiltinIndex();
  }

  async update(file: TFile, force = false): Promise<void> {
    const path = normalizeVaultPath(file.path);
    const current = this.recordsByPath.get(path);
    this.chunksByPath.delete(path);
    this.recordsByPath.delete(path);
    this.sensitivePaths.delete(path);
    if (file.extension !== "md" || this.isExcluded(path)) {
      await this.store.remove(path);
      return;
    }
    if (this.omnisearchProvider?.getStatus().active && !this.builtinReady) return;
    if (!force && current && this.matchesFile(current, file)) {
      this.restoreRecord(current);
      return;
    }
    const content = await this.app.vault.cachedRead(file);
    const sensitive = this.sensitiveGuard.inspectFile(file, content).sensitive;
    const frontmatter = this.app.metadataCache?.getFileCache?.(file)?.frontmatter;
    const chunks = sensitive ? [] : prepareMarkdownChunks(file, content, frontmatter, false).map((chunk) => ({
      ...chunk,
      score: 0,
      tokens: tokenize(chunk.embeddingText)
    }));
    const record: LexicalIndexRecord = {
      path,
      indexVersion: LEXICAL_INDEX_VERSION,
      modifiedAt: file.stat?.mtime ?? 0,
      size: file.stat?.size ?? content.length,
      sensitive,
      chunks: chunks.map(({ score: _score, ...chunk }) => chunk)
    };
    this.recordsByPath.set(path, record);
    if (sensitive) this.sensitivePaths.add(path);
    else this.chunksByPath.set(path, chunks);
    await this.store.put(record);
  }

  remove(path: string): void {
    const normalized = normalizeVaultPath(path);
    this.chunksByPath.delete(normalized);
    this.recordsByPath.delete(normalized);
    this.sensitivePaths.delete(normalized);
    void this.store.remove(normalized).catch((error) =>
      console.warn("[Brain CLI] Could not remove a persisted lexical index record.", error)
    );
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
        console.warn("[Brain CLI] Semantic retrieval failed; using lexical fallback.", error);
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
    persistence: {
      restoredNotes: number;
      updatedNotes: number;
      removedNotes: number;
      skippedForOmnisearch: boolean;
    };
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
      semantic: this.semanticIndex?.getStatus(),
      persistence: { ...this.initializationStats }
    };
  }

  private async lexicalSearch(
    query: string,
    limit: number,
    filters: RetrievalFilters
  ): Promise<{ rows: RankedChunk[]; skippedSensitiveNotes: number }> {
    const omnisearch = await this.omnisearchProvider?.search(query, limit);
    if (omnisearch) {
      const rows: RankedChunk[] = [];
      for (const [index, result] of omnisearch.results.entries()) {
        await this.loadOmnisearchResult(result.path);
        const chunk = this.findChunk(result.path, result.lineStart);
        if (!chunk) {
          if (filters.folders?.length || filters.tags?.length || Object.keys(filters.properties ?? {}).length) continue;
          rows.push({
            id: stableHash(`${result.path}|${result.lineStart}`),
            result,
            rank: index + 1,
            engine: "lexical",
            rawScore: result.score
          });
          continue;
        }
        if (!chunkMatchesFilters(chunk, filters)) continue;
        rows.push({
          id: chunk.id,
          result: { ...result, chunkId: chunk.id },
          rank: index + 1,
          engine: "lexical",
          rawScore: result.score
        });
      }
      return {
        skippedSensitiveNotes: omnisearch.skippedSensitiveNotes,
        rows
      };
    }

    if (!this.builtinReady) await this.ensureBuiltinIndex();
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

  private async ensureBuiltinIndex(): Promise<void> {
    if (this.builtinReady) return;
    if (this.initialization) return this.initialization;
    const build = () => this.buildBuiltinIndex();
    this.initialization = this.performance?.measure("lexical.initialize", build) ?? build();
    try {
      await this.initialization;
    } finally {
      this.initialization = null;
    }
  }

  private async buildBuiltinIndex(): Promise<void> {
    await this.store.initialize();
    const storedRecords = await this.store.getAll();
    const storedByPath = new Map(storedRecords.map((record) => [normalizeVaultPath(record.path), record]));
    const currentFiles = new Map(this.app.vault.getMarkdownFiles()
      .filter((file) => !this.isExcluded(file.path))
      .map((file) => [normalizeVaultPath(file.path), file]));
    this.chunksByPath.clear();
    this.recordsByPath.clear();
    this.sensitivePaths.clear();
    let restoredNotes = 0;
    let updatedNotes = 0;
    let removedNotes = 0;
    for (const [path, record] of storedByPath) {
      const file = currentFiles.get(path);
      if (!file) {
        await this.store.remove(path);
        removedNotes += 1;
        continue;
      }
      if (this.matchesFile(record, file)) {
        this.restoreRecord(record);
        restoredNotes += 1;
        currentFiles.delete(path);
      }
    }
    for (const file of currentFiles.values()) {
      await this.update(file, true);
      updatedNotes += 1;
    }
    this.ready = true;
    this.builtinReady = true;
    this.initializationStats = { restoredNotes, updatedNotes, removedNotes, skippedForOmnisearch: false };
  }

  private restoreRecord(record: LexicalIndexRecord): void {
    const path = normalizeVaultPath(record.path);
    this.recordsByPath.set(path, record);
    if (record.sensitive) {
      this.sensitivePaths.add(path);
      return;
    }
    this.chunksByPath.set(path, record.chunks.map((chunk) => ({ ...chunk, score: 0 })));
  }

  private matchesFile(record: LexicalIndexRecord, file: TFile): boolean {
    return record.indexVersion === LEXICAL_INDEX_VERSION
      && record.modifiedAt === (file.stat?.mtime ?? 0)
      && record.size === (file.stat?.size ?? record.size);
  }

  private async loadOmnisearchResult(path: string): Promise<void> {
    const normalized = normalizeVaultPath(path);
    if (this.chunksByPath.has(normalized) || this.sensitivePaths.has(normalized) || this.isExcluded(normalized)) return;
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (!file || !("extension" in file) || file.extension !== "md") return;
    const markdownFile = file as TFile;
    const content = await this.app.vault.cachedRead(markdownFile);
    if (this.sensitiveGuard.inspectFile(markdownFile, content).sensitive) {
      this.sensitivePaths.add(normalized);
      return;
    }
    const frontmatter = this.app.metadataCache?.getFileCache?.(markdownFile)?.frontmatter;
    this.chunksByPath.set(normalized, prepareMarkdownChunks(markdownFile, content, frontmatter, false).map((chunk) => ({
      ...chunk,
      score: 0,
      tokens: tokenize(chunk.embeddingText)
    })));
  }

  private isExcluded(path: string): boolean {
    const normalized = normalizeVaultPath(path);
    return this.getExcludedPaths().some((excludedPath) => {
      const excluded = normalizeVaultPath(excludedPath);
      return Boolean(excluded) && (normalized === excluded || normalized.startsWith(`${excluded}/`));
    });
  }
}
