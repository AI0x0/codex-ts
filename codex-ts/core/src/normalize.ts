/**
 * mirrors codex-rs/core/src/context_manager/normalize.rs
 *
 * History pairing invariants, enforced right before every model request
 * (mirrors history.for_prompt → normalize_history):
 *   1. every function_call has a corresponding function_call_output
 *      (a missing one gets a synthetic "aborted" output — e.g. the turn was
 *      interrupted, or compaction rewrote history between call and dispatch);
 *   2. every function_call_output has a corresponding function_call
 *      (orphans are dropped).
 *
 * Anthropic (via OpenRouter) hard-rejects unpaired tool_use/tool_result with
 * HTTP 400 ("tool_use ids were found without tool_result blocks immediately
 * after"), which permanently bricks a thread whose history got out of sync —
 * codex-rs never hits this precisely because of this normalization pass.
 */

import type { ConversationItem } from "../../thread-store/src/types.js";

/**
 * Insert a synthetic "aborted" output right after any function_call that has
 * no output. mirrors ensure_call_outputs_present (normalize.rs:14).
 */
export function ensureCallOutputsPresent(items: ConversationItem[]): void {
  const outputIds = new Set<string>();
  for (const item of items) {
    if (item.type === "function_call_output") outputIds.add(item.call_id);
  }
  // Collect insertions first, then apply in reverse to keep indices stable
  // (mirrors the rs missing_outputs_to_insert two-phase approach).
  const missing: { index: number; item: ConversationItem }[] = [];
  items.forEach((item, index) => {
    if (item.type === "function_call" && !outputIds.has(item.call_id)) {
      missing.push({
        index,
        item: {
          type: "function_call_output",
          call_id: item.call_id,
          output: "aborted",
        },
      });
    }
  });
  for (const entry of missing.reverse()) {
    items.splice(entry.index + 1, 0, entry.item);
  }
}

/**
 * Drop any function_call_output whose function_call is gone.
 * mirrors remove_orphan_outputs (normalize.rs:122).
 */
export function removeOrphanOutputs(items: ConversationItem[]): void {
  const callIds = new Set<string>();
  for (const item of items) {
    if (item.type === "function_call") callIds.add(item.call_id);
  }
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.type === "function_call_output" && !callIds.has(item.call_id)) {
      items.splice(i, 1);
    }
  }
}

/**
 * Enforce both pairing invariants in place. Run this on the history right
 * before building a model request. mirrors normalize_history (history.rs:356).
 */
export function normalizeHistory(items: ConversationItem[]): void {
  ensureCallOutputsPresent(items);
  removeOrphanOutputs(items);
}

/**
 * After removing one item from the FRONT of a working history (compaction
 * trim), also remove its call/output counterpart so the pair invariants stay
 * intact without a full pass. mirrors remove_corresponding_for via
 * history.remove_first_item (history.rs:165-175).
 */
export function removeCorrespondingFor(
  items: ConversationItem[],
  removed: ConversationItem,
): void {
  if (
    removed.type !== "function_call" &&
    removed.type !== "function_call_output"
  ) {
    return;
  }
  const counterpartType =
    removed.type === "function_call" ? "function_call_output" : "function_call";
  const index = items.findIndex(
    (item) => item.type === counterpartType && item.call_id === removed.call_id,
  );
  if (index !== -1) {
    items.splice(index, 1);
  }
}
