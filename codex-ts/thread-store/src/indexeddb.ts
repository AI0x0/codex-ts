/**
 * IndexedDBIoBackend — browser persistence for codex-ts threads.
 *
 * Browser-specific extension — no equivalent in codex-rs.
 * codex-rs stores conversation history in .jsonl files on the local filesystem
 * via LocalThreadStore + RolloutRecorder.  Browsers have no filesystem access,
 * so this class provides the same IoBackend contract using IndexedDB instead.
 *
 * Implements IoBackend on top of IndexedDB so conversation history survives
 * page reloads. Each appended line is one record { threadId, line } keyed by an
 * auto-incrementing id; a `threadId` index keeps per-thread reads ordered by
 * insertion order (IndexedDB returns records with equal index keys sorted by
 * primary key, which is the monotonically increasing id).
 *
 * Browser-only: requires a global `indexedDB`. In Node / test environments use
 * InMemoryIoBackend instead.
 */

import type { IoBackend } from "./io_backend.js";

const DB_NAME = "codex-ts";
const STORE_NAME = "thread-lines";
const THREAD_INDEX = "threadId";

interface LineRecord {
  id?: number;
  threadId: string;
  line: string;
}

export class IndexedDBIoBackend implements IoBackend {
  private readonly dbName: string;
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(dbName: string = DB_NAME) {
    this.dbName = dbName;
  }

  private openDb(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(this.dbName, /*version*/ 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, {
            keyPath: "id",
            autoIncrement: true,
          });
          store.createIndex(THREAD_INDEX, "threadId", { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () =>
        reject(req.error ?? new Error("indexedDB.open failed"));
    });
    return this.dbPromise;
  }

  async appendLine(threadId: string, line: string): Promise<void> {
    const db = await this.openDb();
    await runTx(db, "readwrite", (store) => {
      store.add({ threadId, line } satisfies LineRecord);
    });
  }

  async readLines(threadId: string): Promise<string[]> {
    const db = await this.openDb();
    const records = await runRequest<LineRecord[]>(db, "readonly", (store) =>
      store.index(THREAD_INDEX).getAll(threadId),
    );
    return records.map((record) => record.line);
  }

  async listThreadIds(): Promise<string[]> {
    const db = await this.openDb();
    const keys = await runRequest<IDBValidKey[]>(db, "readonly", (store) =>
      store.index(THREAD_INDEX).getAllKeys(),
    );
    return Array.from(new Set(keys.map((key) => String(key))));
  }

  async deleteThread(threadId: string): Promise<void> {
    const db = await this.openDb();
    await runTx(db, "readwrite", (store) => {
      const cursorReq = store.index(THREAD_INDEX).openCursor(threadId);
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
    });
  }
}

// ─── Promise helpers ───────────────────────────────────────────────────────────

/** Run a transaction body and resolve when the transaction completes. */
function runTx(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    body(tx.objectStore(STORE_NAME));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("indexedDB tx failed"));
    tx.onabort = () => reject(tx.error ?? new Error("indexedDB tx aborted"));
  });
}

/** Run a single request and resolve with its result. */
function runRequest<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const req = body(tx.objectStore(STORE_NAME));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () =>
      reject(req.error ?? new Error("indexedDB request failed"));
  });
}
