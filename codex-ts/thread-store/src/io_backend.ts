/**
 * IoBackend — the injectable storage primitive.
 *
 * This is the layer users replace to target different environments:
 *
 *   Node.js  → append/read lines from .jsonl files on disk
 *   Browser  → append/read lines via OPFS or IndexedDB
 *   Test     → in-memory Map (see InMemoryIoBackend below)
 *
 * It is intentionally narrow: only byte-level line I/O and thread enumeration.
 * All serialisation is handled by LocalThreadStore.
 */

export interface IoBackend {
  /** Append one serialised JSON line for a thread */
  appendLine(threadId: string, line: string): Promise<void>;
  /** Return all stored lines for a thread, in append order */
  readLines(threadId: string): Promise<string[]>;
  /** List all thread IDs that have at least one stored line */
  listThreadIds(): Promise<string[]>;
  /** Delete all stored data for a thread */
  deleteThread(threadId: string): Promise<void>;
}

// ─── InMemoryIoBackend (built-in; works in browser and Node.js) ───────────────

export class InMemoryIoBackend implements IoBackend {
  private readonly store = new Map<string, string[]>();

  async appendLine(threadId: string, line: string): Promise<void> {
    const lines = this.store.get(threadId) ?? [];
    lines.push(line);
    this.store.set(threadId, lines);
  }

  async readLines(threadId: string): Promise<string[]> {
    return [...(this.store.get(threadId) ?? [])];
  }

  async listThreadIds(): Promise<string[]> {
    return [...this.store.keys()];
  }

  async deleteThread(threadId: string): Promise<void> {
    this.store.delete(threadId);
  }
}
