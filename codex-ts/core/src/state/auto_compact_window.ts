/**
 * mirrors codex-rs/core/src/state/auto_compact_window.rs
 *
 * Tracks the token baseline for the current compaction window so that
 * BodyAfterPrefix mode can measure context growth since the last compaction
 * rather than total context size.
 */

export interface AutoCompactWindowSnapshot {
  ordinal: number;
  prefillInputTokens: number | null;
}

export class AutoCompactWindow {
  private ordinal = 1;
  /**
   * Absolute input-token baseline for the current window.
   * Set from the first server-observed usage after a new window opens;
   * falls back to an estimated value when the server hasn't responded yet.
   */
  private prefillInputTokens: number | null = null;
  private prefillSource: "server" | "estimated" | null = null;

  clearPrefill(): void {
    this.prefillInputTokens = null;
    this.prefillSource = null;
  }

  /** Called after each compaction to start a fresh measurement window */
  startNext(): void {
    this.ordinal += 1;
    this.clearPrefill();
  }

  /**
   * Records the request-input side of the first server usage sample.
   * Server-observed values take priority and are never overwritten.
   * mirrors: ensure_server_observed_prefill_from_usage
   */
  ensureServerObservedPrefill(inputTokens: number): void {
    if (this.prefillSource === "server") return;
    this.prefillInputTokens = Math.max(0, inputTokens);
    this.prefillSource = "server";
  }

  /**
   * Set an estimated prefill when actual usage isn't available yet.
   * mirrors: set_estimated_prefill
   */
  setEstimatedPrefill(tokens: number): void {
    if (this.prefillSource === "server") return;
    this.prefillInputTokens = Math.max(0, tokens);
    this.prefillSource = "estimated";
  }

  snapshot(): AutoCompactWindowSnapshot {
    return { ordinal: this.ordinal, prefillInputTokens: this.prefillInputTokens };
  }

  /**
   * Tokens added since the start of this window (BodyAfterPrefix mode).
   * Falls back to total when no baseline is recorded yet.
   */
  bodyAfterPrefix(totalInputTokens: number): number {
    const baseline = this.prefillInputTokens ?? totalInputTokens;
    return Math.max(0, totalInputTokens - baseline);
  }
}
