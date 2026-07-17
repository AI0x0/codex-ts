/**
 * mirrors codex-rs/core/src/context_manager/history.rs (the token_info face)
 *         codex-rs/protocol/src/protocol.rs TokenUsageInfo::fill_to_context_window
 *
 * Session-scoped token accounting: the last known size of the active context,
 * fed from server usage after each sampled response, from a byte-based estimate
 * when no usage has arrived yet (fresh/resumed threads, post-compaction), or
 * force-filled to the context window when the provider rejects a request with
 * context-window-exceeded. `autoCompactTokenStatus` in turn.ts reads this to
 * decide when to compact — mirrors sess.get_total_token_usage() in codex-rs.
 */

import type { ConversationItem } from "../../../thread-store/src/types.js";

/** ~4 chars per token — coarse lower bound, same heuristic as codex-rs
 *  approx_token_count (utils/output-truncation). Good enough for budgeting. */
export function approxTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Estimate the token size of serialized conversation items.
 * mirrors history.estimate_token_count_with_base_instructions (history.rs:149):
 * per-item byte-based estimates, summed. JSON form approximates wire size.
 */
export function estimateItemsTokenCount(items: ConversationItem[]): number {
  let total = 0;
  for (const item of items) {
    total += approxTokenCount(JSON.stringify(item));
  }
  return total;
}

export class SessionTokenState {
  /** Last known active-context size in tokens (server usage, estimate, or
   *  forced-full). null until the first sample/estimate. */
  private total: number | null = null;

  get totalTokens(): number | null {
    return this.total;
  }

  /**
   * Record the terminal usage of a sampled response.
   * mirrors record_token_usage_info → history.update_token_info: the session
   * total becomes the response's total_tokens (the active context as the
   * server measured it). Falls back to input+output when total is absent.
   */
  updateFromUsage(input: {
    inputTokens: number;
    outputTokens?: number | undefined;
    totalTokens?: number | undefined;
  }): void {
    const total =
      input.totalTokens ?? input.inputTokens + (input.outputTokens ?? 0);
    this.total = Math.max(0, total);
  }

  /**
   * Seed/replace the total with a byte-based estimate — used before the first
   * server usage arrives and after compaction rewrites history.
   * mirrors recompute_token_usage (session/mod.rs:3059).
   */
  setEstimated(tokens: number): void {
    this.total = Math.max(0, tokens);
  }

  /**
   * Mark the context as FULL after a context-window-exceeded rejection, so the
   * next pre-sampling check is guaranteed to compact first.
   * mirrors set_total_tokens_full (session/mod.rs:3140) — a no-op when the
   * host didn't configure a context window, exactly like the rs guard.
   */
  setFull(contextWindow: number | undefined): void {
    if (contextWindow !== undefined) {
      this.total = contextWindow;
    }
  }
}
