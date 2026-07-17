/**
 * mirrors codex-rs/core/src/responses_retry.rs + codex-rs/core/src/util.rs::backoff
 *
 * Shared retry decisions for Responses API requests: which failures are
 * transient (retryable), and how long to back off between attempts.
 *
 * Unlike codex-rs (which can re-stream in place into a TUI), codex-ts emits
 * AgentMessageContentDelta events live, so the turn loop only retries failures
 * that happen BEFORE any visible output was streamed — see runTurn. The decision
 * helpers here are agnostic to that policy.
 */

// mirrors codex-rs util.rs: INITIAL_DELAY_MS = 200, BACKOFF_FACTOR = 2.0,
// jitter uniform in [0.9, 1.1).
const INITIAL_DELAY_MS = 200;
const BACKOFF_FACTOR = 2;

/** Default retry budget for transient Responses failures (mirrors the spirit of
 *  codex-rs stream_max_retries; the host can override via CodexThreadConfig). */
export const DEFAULT_MAX_RETRIES = 5;

/**
 * Exponential backoff with jitter, in milliseconds.
 * delay = INITIAL_DELAY_MS * BACKOFF_FACTOR^(attempt-1) * jitter(0.9..1.1).
 * `attempt` is 1-based (first retry = 1).
 */
export function backoff(attempt: number): number {
  const exp = BACKOFF_FACTOR ** Math.max(0, attempt - 1);
  const base = INITIAL_DELAY_MS * exp;
  const jitter = 0.9 + Math.random() * 0.2;
  return Math.round(base * jitter);
}

/**
 * A non-2xx Responses API response, carrying the status and (when present) the
 * server-requested Retry-After delay so the retry loop can honor it.
 */
export class ResponsesApiError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | undefined;

  constructor(status: number, body: string, retryAfterMs?: number | undefined) {
    super(`Responses API ${status}: ${body}`);
    this.name = "ResponsesApiError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Whether an HTTP status is a transient failure worth retrying. Mirrors the
 * retryable set in codex-rs (timeouts / 5xx / unexpected status); 4xx are
 * terminal except 408 (request timeout), 409 (conflict) and 429 (rate limit).
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

// mirrors codex-api/src/sse/responses.rs is_context_window_error — codex-rs only
// needs the OpenAI canonical `code: "context_length_exceeded"`, because its
// upstream speaks pure OpenAI. codex-ts rides OpenRouter/codeproxy, whose error
// bodies wrap the ORIGINAL provider error verbatim (`metadata.raw`), so the
// canonical code rarely survives — match each provider's wording too:
//   - OpenAI:            "context_length_exceeded" / "exceeds the context window"
//   - Anthropic/Bedrock: "prompt is too long: N tokens > M maximum"
//   - Gemini:            "input token count ... exceeds the maximum"
const CONTEXT_WINDOW_ERROR_RE =
  /context_length_exceeded|exceeds the context window|prompt is too long|exceeds the maximum number of tokens|input token count .{0,40}exceeds/iu;

/** Message-level probe — rs classifies purely by the error payload (its
 *  canonical `code`), never by HTTP status; SSE `response.failed` has no
 *  status at all. Exposed for both the turn loop and the compaction task. */
export function isContextWindowExceededText(text: string): boolean {
  return CONTEXT_WINDOW_ERROR_RE.test(text);
}

/**
 * Classify a terminal request failure as context-window-exceeded.
 * mirrors CodexErr::ContextWindowExceeded classification: turn.ts marks the
 * session tokens FULL on this error so the next turn compacts before sampling
 * (turn.rs:1045-1047), and compact.ts trims the oldest history item and
 * retries (compact.rs:232-241). Callers must check this BEFORE the retry
 * decision — the same request would fail again.
 */
export function isContextWindowExceededError(error: unknown): boolean {
  return (
    error instanceof ResponsesApiError &&
    isContextWindowExceededText(error.message)
  );
}

/**
 * Classify a thrown error as retryable. Aborts (interrupts) are terminal;
 * ResponsesApiError defers to its status; anything else (network TypeError,
 * dropped stream, JSON/IO error) is treated as a transient connection failure —
 * mirrors codex-rs CodexErr::is_retryable (ConnectionFailed / Stream / Io → true).
 */
export function isRetryableError(error: unknown): boolean {
  if (isAbortError(error)) {
    return false;
  }
  if (error instanceof ResponsesApiError) {
    return isRetryableStatus(error.status);
  }
  return true;
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    error.name === "AbortError"
  ) ||
    (error instanceof Error && error.name === "AbortError");
}

/**
 * Delay before the next attempt: honor a server Retry-After when the error
 * carries one (e.g. 429), otherwise exponential backoff.
 */
export function computeRetryDelay(error: unknown, attempt: number): number {
  if (
    error instanceof ResponsesApiError &&
    error.retryAfterMs !== undefined &&
    error.retryAfterMs >= 0
  ) {
    return error.retryAfterMs;
  }
  return backoff(attempt);
}

/**
 * Parse a Retry-After header (delta-seconds or HTTP-date) into milliseconds.
 * Returns undefined when absent or unparseable.
 */
export function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) {
    return undefined;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}

/**
 * Abortable sleep. Rejects with an AbortError if the signal fires first, so a
 * mid-backoff interrupt cancels the turn promptly.
 */
export function sleep(ms: number, signal?: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
