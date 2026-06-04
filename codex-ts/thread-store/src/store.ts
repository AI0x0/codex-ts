/**
 * mirrors codex-rs/thread-store/src/store.rs
 *
 * ThreadStore — storage-neutral thread persistence boundary.
 * Implement this interface to provide a custom backing store.
 */

import type {
  AppendThreadItemsParams,
  CreateThreadParams,
  LoadThreadHistoryParams,
  ReadThreadParams,
  StoredThread,
  StoredThreadHistory,
  UpdateThreadMetadataParams,
} from "./types.js";

export interface ThreadStore {
  /** Create a new thread record */
  createThread(params: CreateThreadParams): Promise<void>;

  /** Append canonical rollout items to a live thread */
  appendItems(params: AppendThreadItemsParams): Promise<void>;

  /** Load full rollout history for resume / replay */
  loadHistory(params: LoadThreadHistoryParams): Promise<StoredThreadHistory>;

  /** Read thread summary metadata */
  readThread(params: ReadThreadParams): Promise<StoredThread | null>;

  /** Update mutable thread metadata fields */
  updateThreadMetadata(params: UpdateThreadMetadataParams): Promise<void>;

  /** List all stored thread IDs */
  listThreadIds(): Promise<string[]>;
}
