import type { RetrievalFilters, ScoredSemanticChunk, SemanticChunkRecord } from "./semantic-types";
import { chunkMatchesFilters } from "./markdown-chunks";

const DB_VERSION = 1;
const CHUNKS_STORE = "chunks";
const META_STORE = "meta";

const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });

const transactionDone = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction was aborted."));
  });

export interface SemanticIndexStore {
  initialize(): Promise<void>;
  getAll(): Promise<SemanticChunkRecord[]>;
  getByPath(path: string): Promise<SemanticChunkRecord[]>;
  applyPath(path: string, records: SemanticChunkRecord[]): Promise<void>;
  putRecords(records: SemanticChunkRecord[]): Promise<void>;
  removePath(path: string): Promise<void>;
  removeSensitive(): Promise<void>;
  clear(): Promise<void>;
  nearest(vector: Float32Array, filters: RetrievalFilters, limit: number): Promise<ScoredSemanticChunk[]>;
  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta<T>(key: string, value: T): Promise<void>;
}

export class IndexedDbSemanticStore implements SemanticIndexStore {
  private database: IDBDatabase | null = null;
  private recordsCache: SemanticChunkRecord[] | null = null;

  constructor(private readonly databaseName: string) {}

  async initialize(): Promise<void> {
    if (this.database) return;
    if (typeof indexedDB === "undefined") throw new Error("IndexedDB is unavailable in this Obsidian runtime.");
    const request = indexedDB.open(this.databaseName, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(CHUNKS_STORE)) {
        const chunks = database.createObjectStore(CHUNKS_STORE, { keyPath: "id" });
        chunks.createIndex("path", "path", { unique: false });
      }
      if (!database.objectStoreNames.contains(META_STORE)) {
        database.createObjectStore(META_STORE, { keyPath: "key" });
      }
    };
    this.database = await requestResult(request);
  }

  async getAll(): Promise<SemanticChunkRecord[]> {
    if (this.recordsCache) return this.recordsCache;
    const database = await this.getDatabase();
    const transaction = database.transaction(CHUNKS_STORE, "readonly");
    this.recordsCache = await requestResult(
      transaction.objectStore(CHUNKS_STORE).getAll()
    ) as SemanticChunkRecord[];
    return this.recordsCache;
  }

  async getByPath(path: string): Promise<SemanticChunkRecord[]> {
    const database = await this.getDatabase();
    const transaction = database.transaction(CHUNKS_STORE, "readonly");
    return requestResult(transaction.objectStore(CHUNKS_STORE).index("path").getAll(path)) as Promise<SemanticChunkRecord[]>;
  }

  async applyPath(path: string, records: SemanticChunkRecord[]): Promise<void> {
    const database = await this.getDatabase();
    const transaction = database.transaction(CHUNKS_STORE, "readwrite");
    const store = transaction.objectStore(CHUNKS_STORE);
    const keys = await requestResult(store.index("path").getAllKeys(path));
    for (const key of keys) store.delete(key);
    for (const record of records) store.put(record);
    await transactionDone(transaction);
    if (this.recordsCache) {
      this.recordsCache = [
        ...this.recordsCache.filter((record) => record.path !== path),
        ...records
      ];
    }
  }

  async putRecords(records: SemanticChunkRecord[]): Promise<void> {
    if (records.length === 0) return;
    const database = await this.getDatabase();
    const transaction = database.transaction(CHUNKS_STORE, "readwrite");
    const store = transaction.objectStore(CHUNKS_STORE);
    for (const record of records) store.put(record);
    await transactionDone(transaction);
    if (this.recordsCache) {
      const incomingIds = new Set(records.map((record) => record.id));
      this.recordsCache = [
        ...this.recordsCache.filter((record) => !incomingIds.has(record.id)),
        ...records
      ];
    }
  }

  async removePath(path: string): Promise<void> {
    await this.applyPath(path, []);
  }

  async removeSensitive(): Promise<void> {
    const records = await this.getAll();
    const sensitivePaths = [...new Set(records.filter((record) => record.sensitive).map((record) => record.path))];
    for (const path of sensitivePaths) await this.removePath(path);
  }

  async clear(): Promise<void> {
    const database = await this.getDatabase();
    const transaction = database.transaction([CHUNKS_STORE, META_STORE], "readwrite");
    transaction.objectStore(CHUNKS_STORE).clear();
    transaction.objectStore(META_STORE).clear();
    await transactionDone(transaction);
    this.recordsCache = [];
  }

  async nearest(
    vector: Float32Array,
    filters: RetrievalFilters,
    limit: number
  ): Promise<ScoredSemanticChunk[]> {
    const records = await this.getAll();
    return records
      .filter((record) => record.dimensions === vector.length && chunkMatchesFilters(record, filters))
      .map((chunk) => ({ chunk, score: cosineSimilarity(vector, chunk.vector) }))
      .filter(({ score }) => Number.isFinite(score))
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.min(Math.max(Math.floor(limit), 1), 100));
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    const database = await this.getDatabase();
    const transaction = database.transaction(META_STORE, "readonly");
    const result = await requestResult(transaction.objectStore(META_STORE).get(key)) as { key: string; value: T } | undefined;
    return result?.value;
  }

  async setMeta<T>(key: string, value: T): Promise<void> {
    const database = await this.getDatabase();
    const transaction = database.transaction(META_STORE, "readwrite");
    transaction.objectStore(META_STORE).put({ key, value });
    await transactionDone(transaction);
  }

  private async getDatabase(): Promise<IDBDatabase> {
    await this.initialize();
    if (!this.database) throw new Error("Semantic index database did not open.");
    return this.database;
  }
}

export const cosineSimilarity = (left: Float32Array, right: Float32Array): number => {
  if (left.length !== right.length || left.length === 0) return Number.NaN;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm === 0 || rightNorm === 0) return Number.NaN;
  return dot / Math.sqrt(leftNorm * rightNorm);
};

export class MemorySemanticStore implements SemanticIndexStore {
  private readonly records = new Map<string, SemanticChunkRecord>();
  private readonly meta = new Map<string, unknown>();
  async initialize(): Promise<void> {}
  async getAll(): Promise<SemanticChunkRecord[]> { return [...this.records.values()]; }
  async getByPath(path: string): Promise<SemanticChunkRecord[]> {
    return [...this.records.values()].filter((record) => record.path === path);
  }
  async applyPath(path: string, records: SemanticChunkRecord[]): Promise<void> {
    await this.removePath(path);
    for (const record of records) this.records.set(record.id, record);
  }
  async putRecords(records: SemanticChunkRecord[]): Promise<void> {
    for (const record of records) this.records.set(record.id, record);
  }
  async removePath(path: string): Promise<void> {
    for (const [id, record] of this.records) if (record.path === path) this.records.delete(id);
  }
  async removeSensitive(): Promise<void> {
    for (const [id, record] of this.records) if (record.sensitive) this.records.delete(id);
  }
  async clear(): Promise<void> { this.records.clear(); this.meta.clear(); }
  async nearest(vector: Float32Array, filters: RetrievalFilters, limit: number): Promise<ScoredSemanticChunk[]> {
    return [...this.records.values()]
      .filter((record) => chunkMatchesFilters(record, filters))
      .map((chunk) => ({ chunk, score: cosineSimilarity(vector, chunk.vector) }))
      .filter(({ score }) => Number.isFinite(score))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }
  async getMeta<T>(key: string): Promise<T | undefined> { return this.meta.get(key) as T | undefined; }
  async setMeta<T>(key: string, value: T): Promise<void> { this.meta.set(key, value); }
}
