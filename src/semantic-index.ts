import { TFile, type App } from "obsidian";
import { normalizeVaultPath, prepareMarkdownChunks } from "./markdown-chunks";
import type { BrainSettings } from "./settings";
import type { SensitiveContentGuard } from "./sensitive-content";
import type { SemanticIndexStore } from "./semantic-store";
import type {
  EmbeddingModel,
  EmbeddingProvider,
  PreparedChunk,
  RetrievalFilters,
  ScoredSemanticChunk,
  SemanticChunkRecord,
  SemanticIndexStatus,
  SemanticProgressListener
} from "./semantic-types";
import { throwIfAborted } from "./abort";

const INDEX_VERSION = 1;
const CHUNKER_VERSION = 1;
const METADATA_VERSION = 1;
const BATCH_SIZE = 16;
const BATCH_CHARACTER_LIMIT = 32_000;
const UPDATE_DEBOUNCE_MS = 900;
const QUERY_CACHE_SIZE = 20;

const isRecoverableEmbeddingInputError = (error: unknown): boolean =>
  /(?:http\s+422|input length|maximum\s+\d+|context length|too long|truncate)/i.test(
    error instanceof Error ? error.message : String(error)
  );

const emptyStatus = (): SemanticIndexStatus => ({
  enabled: false,
  state: "disabled",
  reason: null,
  modelId: "",
  folders: [],
  indexedNotes: 0,
  indexedChunks: 0,
  totalNotes: 0,
  totalChunks: 0,
  queuedNotes: 0,
  completedChunks: 0,
  failedChunks: 0,
  skippedSensitiveNotes: 0,
  promptTokens: 0,
  estimatedCostUsd: 0,
  startedAt: null,
  elapsedMs: 0,
  partial: false,
  lastError: null
});

export class SemanticIndexCoordinator {
  private status = emptyStatus();
  private activeController: AbortController | null = null;
  private activePromise: Promise<void> | null = null;
  private updateTimer: number | null = null;
  private readonly pendingPaths = new Set<string>();
  private readonly pendingVersions = new Map<string, number>();
  private readonly removedPaths = new Set<string>();
  private readonly listeners = new Set<SemanticProgressListener>();
  private readonly queryCache = new Map<string, Float32Array>();

  constructor(
    private readonly app: App,
    private readonly getSettings: () => BrainSettings,
    private readonly getExcludedPaths: () => string[],
    private readonly sensitiveGuard: SensitiveContentGuard,
    private readonly store: SemanticIndexStore,
    private readonly embeddings: EmbeddingProvider,
    private readonly getEmbeddingModels: () => EmbeddingModel[]
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.refreshStoredCounts();
    const settings = this.getSettings();
    this.status = {
      ...this.status,
      enabled: settings.semanticSearchEnabled,
      state: settings.semanticSearchEnabled ? "idle" : "disabled",
      modelId: settings.embeddingModel,
      folders: [...settings.semanticFolders]
    };
    this.emit();
    if (settings.semanticSearchEnabled && settings.embeddingModel && settings.semanticFolders.length > 0) {
      void this.start("enable").catch((error) =>
        console.error("[Brain CLI] Automatic semantic resume failed.", error)
      );
    }
  }

  subscribe(listener: SemanticProgressListener): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => this.listeners.delete(listener);
  }

  getStatus(): SemanticIndexStatus {
    return {
      ...this.status,
      elapsedMs: this.status.startedAt ? Date.now() - this.status.startedAt : this.status.elapsedMs,
      folders: [...this.status.folders]
    };
  }

  async start(reason: "enable" | "rebuild" | "vault-change", allowUnknownPricing = false): Promise<void> {
    if (this.activePromise) return this.activePromise;
    const settings = this.getSettings();
    if (!settings.semanticSearchEnabled) {
      this.patchStatus({ enabled: false, state: "disabled", reason });
      return;
    }
    if (!settings.embeddingModel) throw new Error("Choose an embedding model before enabling semantic search.");
    if (settings.semanticFolders.length === 0) throw new Error("Choose at least one semantic index folder.");

    this.activeController = new AbortController();
    this.activePromise = this.rebuild(reason, this.activeController.signal, allowUnknownPricing)
      .finally(() => {
        this.activeController = null;
        this.activePromise = null;
        if (this.pendingPaths.size > 0 && this.status.state === "idle") this.scheduleQueuedUpdates(0);
      });
    return this.activePromise;
  }

  pause(): void {
    this.patchStatus({ state: "paused", reason: "user", partial: true });
    this.activeController?.abort();
  }

  disable(): void {
    this.patchStatus({ enabled: false, state: "disabled", reason: null, partial: this.status.indexedChunks > 0 });
    this.clearQueuedUpdates();
    this.activeController?.abort();
  }

  async resume(allowUnknownPricing = false): Promise<void> {
    this.patchStatus({ state: "idle", reason: "resume" });
    await this.start("rebuild", allowUnknownPricing);
  }

  async refresh(allowUnknownPricing = false): Promise<void> {
    this.activeController?.abort();
    await this.activePromise?.catch(() => undefined);
    this.patchStatus({ state: "idle", reason: "rebuild" });
    await this.start("rebuild", allowUnknownPricing);
  }

  async reconfigure(): Promise<void> {
    this.activeController?.abort();
    await this.activePromise?.catch(() => undefined);
    if (this.getSettings().semanticSearchEnabled) await this.start("rebuild");
  }

  cancel(): void {
    this.patchStatus({ state: "cancelled", reason: "user", partial: true });
    this.clearQueuedUpdates();
    this.activeController?.abort();
  }

  dispose(): void {
    this.clearQueuedUpdates();
    this.activeController?.abort();
    this.listeners.clear();
  }

  async clear(): Promise<void> {
    this.cancel();
    await this.activePromise?.catch(() => undefined);
    if (this.updateTimer !== null) {
      window.clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
    this.pendingPaths.clear();
    this.pendingVersions.clear();
    this.removedPaths.clear();
    await this.store.clear();
    this.queryCache.clear();
    this.status = {
      ...emptyStatus(),
      enabled: this.getSettings().semanticSearchEnabled,
      state: this.getSettings().semanticSearchEnabled ? "idle" : "disabled",
      modelId: this.getSettings().embeddingModel,
      folders: [...this.getSettings().semanticFolders]
    };
    this.emit();
  }

  queueUpdate(file: TFile): void {
    if (!this.getSettings().semanticSearchEnabled) return;
    const path = normalizeVaultPath(file.path);
    if (!this.isInScope(path)) {
      this.pendingPaths.delete(path);
      this.pendingVersions.delete(path);
      return;
    }
    this.removedPaths.delete(path);
    this.pendingPaths.add(path);
    this.pendingVersions.set(path, (this.pendingVersions.get(path) ?? 0) + 1);
    if (!this.activePromise && !["paused", "cancelled", "disabled"].includes(this.status.state)) {
      this.patchStatus({ queuedNotes: this.pendingPaths.size });
      this.scheduleQueuedUpdates(UPDATE_DEBOUNCE_MS);
    }
  }

  async remove(path: string): Promise<void> {
    const normalized = normalizeVaultPath(path);
    this.removedPaths.add(normalized);
    this.pendingPaths.delete(normalized);
    this.pendingVersions.delete(normalized);
    await this.store.removePath(normalized);
    await this.refreshStoredCounts();
    this.emit();
  }

  async removeSensitive(): Promise<void> {
    this.activeController?.abort();
    await this.activePromise?.catch(() => undefined);
    await this.store.removeSensitive();
    await this.refreshStoredCounts();
    this.emit();
  }

  async search(
    query: string,
    filters: RetrievalFilters = {},
    limit = 30,
    signal?: AbortSignal
  ): Promise<ScoredSemanticChunk[]> {
    throwIfAborted(signal);
    const settings = this.getSettings();
    if (!settings.semanticSearchEnabled || !settings.embeddingModel) return [];
    const trimmed = query.trim();
    if (!trimmed) return [];
    const cacheKey = `${settings.embeddingModel}\u0000${trimmed}`;
    let vector = this.queryCache.get(cacheKey);
    if (!vector) {
      const controller = signal ? null : new AbortController();
      const embedded = await this.embeddings.embed(settings.embeddingModel, [trimmed], signal ?? controller!.signal);
      throwIfAborted(signal);
      vector = embedded.vectors[0];
      if (!vector) throw new Error("The embedding provider returned no query vector.");
      this.queryCache.set(cacheKey, vector);
      while (this.queryCache.size > QUERY_CACHE_SIZE) {
        const oldest = this.queryCache.keys().next().value as string | undefined;
        if (!oldest) break;
        this.queryCache.delete(oldest);
      }
    }
    throwIfAborted(signal);
    return this.store.nearest(vector, filters, limit);
  }

  private async rebuild(
    reason: "enable" | "rebuild" | "vault-change",
    signal: AbortSignal,
    allowUnknownPricing: boolean
  ): Promise<void> {
    const settings = this.getSettings();
    this.patchStatus({
      enabled: true,
      state: "running",
      reason,
      modelId: settings.embeddingModel,
      folders: [...settings.semanticFolders],
      totalNotes: 0,
      totalChunks: 0,
      completedChunks: 0,
      failedChunks: 0,
      skippedSensitiveNotes: 0,
      promptTokens: 0,
      estimatedCostUsd: 0,
      startedAt: Date.now(),
      elapsedMs: 0,
      partial: true,
      lastError: null
    });

    try {
      const files = this.app.vault.getMarkdownFiles().filter((file) => this.isInScope(file.path));
      const existing = await this.store.getAll();
      const activePaths = new Set(files.map((file) => normalizeVaultPath(file.path)));
      for (const path of new Set(existing.map((record) => record.path))) {
        if (!activePaths.has(path)) await this.store.removePath(path);
      }

      const prepared = new Map<string, PreparedChunk[]>();
      const preparedVersions = new Map<string, number>();
      let skippedSensitiveNotes = 0;
      for (const file of files) {
        if (signal.aborted) throw new DOMException("The operation was aborted.", "AbortError");
        const path = normalizeVaultPath(file.path);
        const queuedVersion = this.pendingVersions.get(path) ?? 0;
        const content = await this.app.vault.cachedRead(file);
        const sensitive = this.sensitiveGuard.inspectFile(file, content).sensitive;
        if (sensitive && !settings.includeSensitiveSemantic) {
          skippedSensitiveNotes += 1;
          await this.store.removePath(file.path);
          this.clearReconciledPending(path, queuedVersion);
          continue;
        }
        prepared.set(path, prepareMarkdownChunks(
          file,
          content,
          this.app.metadataCache.getFileCache(file)?.frontmatter,
          sensitive
        ));
        preparedVersions.set(path, queuedVersion);
      }

      const pending = [...prepared.entries()].flatMap(([path, chunks]) => {
        const current = existing.filter((record) => record.path === path);
        return chunks.filter((chunk) => {
          const previous = current.find((record) => record.id === chunk.id);
          return !previous
            || previous.contentHash !== chunk.contentHash
            || previous.modelId !== settings.embeddingModel
            || previous.indexVersion !== INDEX_VERSION
            || previous.chunkerVersion !== CHUNKER_VERSION
            || previous.metadataVersion !== METADATA_VERSION;
        });
      });
      this.patchStatus({
        totalNotes: prepared.size,
        totalChunks: [...prepared.values()].reduce((total, chunks) => total + chunks.length, 0),
        queuedNotes: prepared.size,
        skippedSensitiveNotes
      });
      this.ensureWithinCostCap(pending, allowUnknownPricing);

      for (const [path, chunks] of prepared) {
        if (signal.aborted) throw new DOMException("The operation was aborted.", "AbortError");
        if (this.removedPaths.has(path)) {
          await this.store.removePath(path);
          continue;
        }
        const current = await this.store.getByPath(path);
        const reusable = new Map(current
          .filter((record) =>
            record.modelId === settings.embeddingModel
            && record.indexVersion === INDEX_VERSION
            && record.chunkerVersion === CHUNKER_VERSION
            && record.metadataVersion === METADATA_VERSION)
          .map((record) => [record.id, record]));
        const retained = chunks.flatMap((chunk) => {
          const previous = reusable.get(chunk.id);
          return previous?.contentHash === chunk.contentHash ? [previous] : [];
        });
        if (retained.length === chunks.length && current.length === chunks.length) {
          this.clearReconciledPending(path, preparedVersions.get(path) ?? 0);
          this.patchStatus({ queuedNotes: Math.max(0, this.status.queuedNotes - 1) });
          continue;
        }
        // Commit the desired cached subset first. Each subsequent embedding
        // batch is upserted separately, making every completed batch resumable.
        await this.store.applyPath(path, retained);
        await this.refreshStoredCounts();
        let cursor = 0;
        while (cursor < chunks.length) {
          const chunk = chunks[cursor];
          const previous = reusable.get(chunk.id);
          if (previous?.contentHash === chunk.contentHash) {
            cursor += 1;
            continue;
          }
          const batch: PreparedChunk[] = [];
          let characters = 0;
          while (cursor < chunks.length && batch.length < BATCH_SIZE) {
            const candidate = chunks[cursor];
            const cached = reusable.get(candidate.id);
            if (cached?.contentHash === candidate.contentHash) break;
            if (batch.length > 0 && characters + candidate.embeddingText.length > BATCH_CHARACTER_LIMIT) break;
            batch.push(candidate);
            characters += candidate.embeddingText.length;
            cursor += 1;
          }
          if (batch.length === 0) continue;
          try {
            const embedded = await this.embeddings.embed(
              settings.embeddingModel,
              batch.map((candidate) => candidate.embeddingText),
              signal
            );
            const price = this.embeddingPricePerToken();
            const usedTokens = embedded.promptTokens || Math.ceil(
              batch.reduce((total, candidate) => total + candidate.embeddingText.length, 0) / 4
            );
            const batchRecords: SemanticChunkRecord[] = [];
            batch.forEach((candidate, index) => {
              const vector = embedded.vectors[index];
              batchRecords.push({
                ...candidate,
                vector,
                modelId: settings.embeddingModel,
                dimensions: vector.length,
                indexVersion: INDEX_VERSION,
                chunkerVersion: CHUNKER_VERSION,
                metadataVersion: METADATA_VERSION,
                updatedAt: Date.now()
              });
            });
            await this.store.putRecords(batchRecords);
            await this.refreshStoredCounts();
            this.patchStatus({
              promptTokens: this.status.promptTokens + usedTokens,
              estimatedCostUsd: (this.status.promptTokens + usedTokens) * (price ?? 0),
              completedChunks: this.status.completedChunks + batch.length
            });
          } catch (error) {
            if (!isRecoverableEmbeddingInputError(error)) {
              this.patchStatus({ failedChunks: this.status.failedChunks + batch.length });
              throw error;
            }
            // A provider can reject one member of a batch for its tokenization
            // even when our character bound is respected. Isolate that member
            // so valid chunks still checkpoint and the queue keeps moving.
            const recoveredRecords: SemanticChunkRecord[] = [];
            let recoveredTokens = 0;
            let failed = 0;
            for (const candidate of batch) {
              try {
                const embedded = await this.embeddings.embed(
                  settings.embeddingModel,
                  [candidate.embeddingText],
                  signal
                );
                const vector = embedded.vectors[0];
                if (!vector) throw new Error("OpenRouter returned an incomplete embedding batch.");
                recoveredTokens += embedded.promptTokens
                  || Math.ceil(candidate.embeddingText.length / 4);
                recoveredRecords.push({
                  ...candidate,
                  vector,
                  modelId: settings.embeddingModel,
                  dimensions: vector.length,
                  indexVersion: INDEX_VERSION,
                  chunkerVersion: CHUNKER_VERSION,
                  metadataVersion: METADATA_VERSION,
                  updatedAt: Date.now()
                });
              } catch (candidateError) {
                if (!isRecoverableEmbeddingInputError(candidateError)) throw candidateError;
                failed += 1;
              }
            }
            if (recoveredRecords.length > 0) {
              await this.store.putRecords(recoveredRecords);
              await this.refreshStoredCounts();
            }
            const price = this.embeddingPricePerToken();
            const failedMessage = failed > 0
              ? `Skipped ${failed} embedding input${failed === 1 ? "" : "s"} rejected by the model's context limit.`
              : this.status.lastError;
            this.patchStatus({
              promptTokens: this.status.promptTokens + recoveredTokens,
              estimatedCostUsd: (this.status.promptTokens + recoveredTokens) * (price ?? 0),
              completedChunks: this.status.completedChunks + recoveredRecords.length,
              failedChunks: this.status.failedChunks + failed,
              lastError: failedMessage
            });
          }
        }
        this.clearReconciledPending(path, preparedVersions.get(path) ?? 0);
        this.patchStatus({ queuedNotes: Math.max(0, this.status.queuedNotes - 1) });
      }
      await this.store.setMeta("index", {
        modelId: settings.embeddingModel,
        indexVersion: INDEX_VERSION,
        chunkerVersion: CHUNKER_VERSION,
        metadataVersion: METADATA_VERSION,
        completedAt: Date.now()
      });
      await this.refreshStoredCounts();
      this.patchStatus({
        state: "idle",
        reason: null,
        queuedNotes: this.pendingPaths.size,
        partial: this.status.failedChunks > 0,
        elapsedMs: this.status.startedAt ? Date.now() - this.status.startedAt : 0,
        startedAt: null
      });
    } catch (error) {
      if (signal.aborted) {
        if (!["paused", "cancelled", "disabled"].includes(this.status.state)) {
          this.patchStatus({ state: "cancelled", partial: true, startedAt: null });
        }
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const costPause = /spend cap|pricing is unavailable/i.test(message);
      this.patchStatus({
        state: costPause ? "paused" : "error",
        partial: true,
        lastError: message,
        startedAt: null
      });
      if (!costPause) throw error;
    }
  }

  private ensureWithinCostCap(chunks: PreparedChunk[], allowUnknownPricing: boolean): void {
    if (allowUnknownPricing) return;
    const cap = this.getSettings().semanticSpendCapUsd;
    if (cap <= 0) return;
    const price = this.embeddingPricePerToken();
    if (price === null) {
      throw new Error("Embedding pricing is unavailable. Resume with --uncapped or choose a priced model.");
    }
    const estimatedTokens = chunks.reduce((total, chunk) => total + Math.ceil(chunk.embeddingText.length / 4), 0);
    const estimate = estimatedTokens * price;
    this.patchStatus({ estimatedCostUsd: estimate });
    if (estimate > cap) {
      throw new Error(`Estimated embedding cost $${estimate.toFixed(4)} exceeds the $${cap.toFixed(2)} spend cap.`);
    }
  }

  private embeddingPricePerToken(): number | null {
    const selected = this.getEmbeddingModels().find((model) => model.id === this.getSettings().embeddingModel);
    const raw = selected?.pricing?.prompt;
    if (typeof raw !== "string") return null;
    const price = Number.parseFloat(raw);
    return Number.isFinite(price) && price >= 0 ? price : null;
  }

  private scheduleQueuedUpdates(delay: number): void {
    if (this.updateTimer !== null) window.clearTimeout(this.updateTimer);
    this.updateTimer = window.setTimeout(() => {
      this.updateTimer = null;
      void this.processQueuedUpdates();
    }, delay);
  }

  private async processQueuedUpdates(): Promise<void> {
    if (
      this.activePromise
      || ["paused", "cancelled", "disabled"].includes(this.status.state)
      || this.pendingPaths.size === 0
    ) return;
    const paths = [...this.pendingPaths];
    this.pendingPaths.clear();
    this.patchStatus({ queuedNotes: paths.length });
    // A full reconciliation still reads only the selected Markdown notes and
    // content hashes ensure that OpenRouter receives changed chunks only.
    await this.start("vault-change").catch((error) => {
      console.error("[Brain CLI] Semantic incremental update failed.", error);
    });
  }

  private clearReconciledPending(path: string, version: number): void {
    if ((this.pendingVersions.get(path) ?? 0) !== version) return;
    this.pendingPaths.delete(path);
    this.pendingVersions.delete(path);
  }

  private clearQueuedUpdates(): void {
    if (this.updateTimer !== null) {
      window.clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
    this.pendingPaths.clear();
    this.pendingVersions.clear();
    this.removedPaths.clear();
    this.patchStatus({ queuedNotes: 0 });
  }

  private isInScope(path: string): boolean {
    const normalized = normalizeVaultPath(path);
    if (this.getExcludedPaths().some((value) => {
      const excluded = normalizeVaultPath(value);
      return excluded && (normalized === excluded || normalized.startsWith(`${excluded}/`));
    })) return false;
    return this.getSettings().semanticFolders.some((value) => {
      const folder = normalizeVaultPath(value);
      return folder === "" || normalized === folder || normalized.startsWith(`${folder}/`);
    });
  }

  private async refreshStoredCounts(): Promise<void> {
    const records = await this.store.getAll();
    this.status.indexedChunks = records.length;
    this.status.indexedNotes = new Set(records.map((record) => record.path)).size;
  }

  private patchStatus(patch: Partial<SemanticIndexStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit();
  }

  private emit(): void {
    const snapshot = this.getStatus();
    for (const listener of this.listeners) listener(snapshot);
  }
}
