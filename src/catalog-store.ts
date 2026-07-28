const DB_VERSION = 1;
const CATALOGS_STORE = "catalogs";

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

export interface CatalogStore {
  initialize(): Promise<void>;
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
}

export class IndexedDbCatalogStore implements CatalogStore {
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
      if (!database.objectStoreNames.contains(CATALOGS_STORE)) {
        database.createObjectStore(CATALOGS_STORE, { keyPath: "key" });
      }
    };
    this.database = await requestResult(request);
  }

  async get<T>(key: string): Promise<T | undefined> {
    const database = await this.getDatabase();
    const transaction = database.transaction(CATALOGS_STORE, "readonly");
    const row = await requestResult(
      transaction.objectStore(CATALOGS_STORE).get(key)
    ) as { key: string; value: T } | undefined;
    return row?.value;
  }

  async set<T>(key: string, value: T): Promise<void> {
    const database = await this.getDatabase();
    const transaction = database.transaction(CATALOGS_STORE, "readwrite");
    transaction.objectStore(CATALOGS_STORE).put({ key, value });
    await transactionDone(transaction);
  }

  private async getDatabase(): Promise<IDBDatabase> {
    await this.initialize();
    if (!this.database) throw new Error("Catalog cache database did not open.");
    return this.database;
  }
}

export class MemoryCatalogStore implements CatalogStore {
  private readonly rows = new Map<string, unknown>();
  async initialize(): Promise<void> {}
  async get<T>(key: string): Promise<T | undefined> { return this.rows.get(key) as T | undefined; }
  async set<T>(key: string, value: T): Promise<void> { this.rows.set(key, value); }
}
