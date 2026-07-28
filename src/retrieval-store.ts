import type { PreparedChunk } from "./semantic-types";

const DB_VERSION = 1;
const PATHS_STORE = "paths";

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

export interface StoredLexicalChunk extends PreparedChunk {
  tokens: string[];
}

export interface LexicalIndexRecord {
  path: string;
  indexVersion: number;
  modifiedAt: number;
  size: number;
  sensitive: boolean;
  chunks: StoredLexicalChunk[];
}

export interface LexicalIndexStore {
  initialize(): Promise<void>;
  getAll(): Promise<LexicalIndexRecord[]>;
  put(record: LexicalIndexRecord): Promise<void>;
  remove(path: string): Promise<void>;
  clear(): Promise<void>;
}

export class IndexedDbLexicalIndexStore implements LexicalIndexStore {
  private database: IDBDatabase | null = null;

  constructor(private readonly databaseName: string) {}

  async initialize(): Promise<void> {
    if (this.database) return;
    if (typeof indexedDB === "undefined") {
      throw new Error("IndexedDB is unavailable in this Obsidian runtime.");
    }
    const request = indexedDB.open(this.databaseName, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PATHS_STORE)) {
        database.createObjectStore(PATHS_STORE, { keyPath: "path" });
      }
    };
    this.database = await requestResult(request);
  }

  async getAll(): Promise<LexicalIndexRecord[]> {
    const database = await this.getDatabase();
    const transaction = database.transaction(PATHS_STORE, "readonly");
    return requestResult(transaction.objectStore(PATHS_STORE).getAll()) as Promise<LexicalIndexRecord[]>;
  }

  async put(record: LexicalIndexRecord): Promise<void> {
    const database = await this.getDatabase();
    const transaction = database.transaction(PATHS_STORE, "readwrite");
    transaction.objectStore(PATHS_STORE).put(record);
    await transactionDone(transaction);
  }

  async remove(path: string): Promise<void> {
    const database = await this.getDatabase();
    const transaction = database.transaction(PATHS_STORE, "readwrite");
    transaction.objectStore(PATHS_STORE).delete(path);
    await transactionDone(transaction);
  }

  async clear(): Promise<void> {
    const database = await this.getDatabase();
    const transaction = database.transaction(PATHS_STORE, "readwrite");
    transaction.objectStore(PATHS_STORE).clear();
    await transactionDone(transaction);
  }

  private async getDatabase(): Promise<IDBDatabase> {
    await this.initialize();
    if (!this.database) throw new Error("Lexical index database did not open.");
    return this.database;
  }
}

export class MemoryLexicalIndexStore implements LexicalIndexStore {
  private readonly records = new Map<string, LexicalIndexRecord>();
  async initialize(): Promise<void> {}
  async getAll(): Promise<LexicalIndexRecord[]> { return [...this.records.values()]; }
  async put(record: LexicalIndexRecord): Promise<void> { this.records.set(record.path, record); }
  async remove(path: string): Promise<void> { this.records.delete(path); }
  async clear(): Promise<void> { this.records.clear(); }
}
