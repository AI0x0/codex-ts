/**
 * mirrors codex-rs/thread-store/src/in_memory.rs
 *
 * InMemoryThreadStore — reference implementation that works in both
 * browser and Node.js without any I/O.  Suitable for tests and ephemeral use.
 *
 * For durable storage supply a custom IoBackend to LocalThreadStore instead.
 */

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

interface ThreadState {
  metadata: ThreadMetadata;
  items: RolloutItem[];
}

export class InMemoryThreadStore implements ThreadStore {
  private readonly threads = new Map<string, ThreadState>();

  async createThread(params: CreateThreadParams): Promise<void> {
    const now = params.createdAtMs;
    this.threads.set(params.threadId, {
      metadata: {
        threadId: params.threadId,
        preview: params.preview ?? "",
        model: params.model,
        createdAtMs: now,
        updatedAtMs: now,
      },
      items: [],
    });
  }

  async appendItems(params: AppendThreadItemsParams): Promise<void> {
    // Auto-create on first append (upsert semantics, mirrors SQLite INSERT OR IGNORE)
    if (!this.threads.has(params.threadId)) {
      const now = Date.now();
      this.threads.set(params.threadId, {
        metadata: {
          threadId: params.threadId,
          preview: "",
          model: "",
          createdAtMs: now,
          updatedAtMs: now,
        },
        items: [],
      });
    }
    const state = this.threads.get(params.threadId)!;
    state.items.push(...params.items);
    state.metadata.updatedAtMs = Date.now();
  }

  async loadHistory(
    params: LoadThreadHistoryParams,
  ): Promise<StoredThreadHistory> {
    const state = this.threads.get(params.threadId);
    return {
      threadId: params.threadId,
      items: state ? [...state.items] : [],
    };
  }

  async readThread(params: ReadThreadParams): Promise<StoredThread | null> {
    const state = this.threads.get(params.threadId);
    if (!state) return null;
    return { threadId: params.threadId, metadata: { ...state.metadata } };
  }

  async updateThreadMetadata(params: UpdateThreadMetadataParams): Promise<void> {
    const state = this.threads.get(params.threadId);
    if (!state) return;
    if (params.preview !== undefined) state.metadata.preview = params.preview;
    if (params.model !== undefined) state.metadata.model = params.model;
    state.metadata.updatedAtMs = Date.now();
  }

  async listThreadIds(): Promise<string[]> {
    return [...this.threads.keys()];
  }
}
