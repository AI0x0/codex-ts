/**
 * mirrors codex-rs/thread-store/src/local/ (LocalThreadStore)
 *
 * LocalThreadStore — durable ThreadStore that serialises RolloutItems as
 * newline-delimited JSON and delegates byte I/O to an injected IoBackend.
 *
 * Supply any IoBackend implementation:
 *   - InMemoryIoBackend     → ephemeral, works everywhere (default)
 *   - Custom Node.js impl  → fs.appendFile / fs.readFile on .jsonl files
 *   - Custom browser impl  → OPFS FileSystemWritableFileStream / read
 */

import type { IoBackend } from "./io_backend.js";
import type { ThreadStore } from "./store.js";
import type {
  AppendThreadItemsParams,
  CreateThreadParams,
  LoadThreadHistoryParams,
  ReadThreadParams,
  RolloutItem,
  StoredThread,
  StoredThreadHistory,
  ThreadMetadata,
  UpdateThreadMetadataParams,
} from "./types.js";

// Metadata is stored as a special first line in each thread's log.
const META_KIND = "__meta__";
type MetaLine = { kind: typeof META_KIND; metadata: ThreadMetadata };

function isMetaLine(obj: unknown): obj is MetaLine {
  return (
    typeof obj === "object" &&
    obj !== null &&
    (obj as Record<string, unknown>)["kind"] === META_KIND
  );
}

export class LocalThreadStore implements ThreadStore {
  constructor(private readonly io: IoBackend) {}

  async createThread(params: CreateThreadParams): Promise<void> {
    const metadata: ThreadMetadata = {
      threadId: params.threadId,
      preview: params.preview ?? "",
      model: params.model,
      createdAtMs: params.createdAtMs,
      updatedAtMs: params.createdAtMs,
    };
    const metaLine: MetaLine = { kind: META_KIND, metadata };
    await this.io.appendLine(params.threadId, JSON.stringify(metaLine));
  }

  async appendItems(params: AppendThreadItemsParams): Promise<void> {
    for (const item of params.items) {
      await this.io.appendLine(params.threadId, JSON.stringify(item));
    }
  }

  async loadHistory(
    params: LoadThreadHistoryParams,
  ): Promise<StoredThreadHistory> {
    const lines = await this.io.readLines(params.threadId);
    const items: RolloutItem[] = [];
    for (const line of lines) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isMetaLine(parsed)) {
          items.push(parsed as RolloutItem);
        }
      } catch {
        /* skip malformed lines */
      }
    }
    return { threadId: params.threadId, items };
  }

  async readThread(params: ReadThreadParams): Promise<StoredThread | null> {
    const lines = await this.io.readLines(params.threadId);
    if (lines.length === 0) return null;
    for (const line of lines) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (isMetaLine(parsed)) {
          return { threadId: params.threadId, metadata: parsed.metadata };
        }
      } catch {
        /* skip */
      }
    }
    return null;
  }

  async updateThreadMetadata(params: UpdateThreadMetadataParams): Promise<void> {
    // Read current metadata, patch it, and append an updated meta line.
    // The last meta line wins on read (latest-wins strategy).
    const current = await this.readThread({ threadId: params.threadId });
    const metadata: ThreadMetadata = {
      ...(current?.metadata ?? {
        threadId: params.threadId,
        preview: "",
        model: "",
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      }),
      ...(params.preview !== undefined ? { preview: params.preview } : {}),
      ...(params.model !== undefined ? { model: params.model } : {}),
      updatedAtMs: Date.now(),
    };
    const metaLine: MetaLine = { kind: META_KIND, metadata };
    await this.io.appendLine(params.threadId, JSON.stringify(metaLine));
  }

  async listThreadIds(): Promise<string[]> {
    return this.io.listThreadIds();
  }
}
