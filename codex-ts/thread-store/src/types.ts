/**
 * mirrors codex-rs/thread-store/src/types.rs  (subset)
 * mirrors codex-rs/protocol/src/protocol.rs   (RolloutItem)
 */

import type { EventMsg } from "../../protocol/src/protocol.js";

// ─── ConversationItem (what gets sent to the Responses API) ───────────────────

export type ConversationItem =
  | { role: "user"; content: string | { type: "input_text"; text: string }[] }
  | { role: "assistant"; content: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

// ─── RolloutItem — mirrors codex-rs/protocol/src/protocol.rs RolloutItem ─────
//
// The serialisable unit persisted to the backing store.
// SessionMeta / ResponseItem / Compacted variants are omitted; we only need
// ConversationItem (history) and EventMsg (for replay / analytics).

export type RolloutItem =
  | { kind: "ConversationItem"; item: ConversationItem }
  | { kind: "EventMsg"; msg: EventMsg };

// ─── Params — mirrors codex-rs/thread-store/src/types.rs ─────────────────────

export interface CreateThreadParams {
  threadId: string;
  /** First user message, used as preview */
  preview?: string | undefined;
  model: string;
  createdAtMs: number;
}

export interface AppendThreadItemsParams {
  threadId: string;
  items: RolloutItem[];
}

export interface LoadThreadHistoryParams {
  threadId: string;
}

export interface ReadThreadParams {
  threadId: string;
}

export interface UpdateThreadMetadataParams {
  threadId: string;
  preview?: string | undefined;
  model?: string | undefined;
}

// ─── Stored types ─────────────────────────────────────────────────────────────

export interface ThreadMetadata {
  threadId: string;
  preview: string;
  model: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface StoredThreadHistory {
  threadId: string;
  /** RolloutItems in append order */
  items: RolloutItem[];
}

export interface StoredThread {
  threadId: string;
  metadata: ThreadMetadata;
  /** Populated only when requested (mirrors include_history flag) */
  history?: StoredThreadHistory | undefined;
}
