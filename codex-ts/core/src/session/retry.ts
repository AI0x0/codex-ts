/**
 * mirrors codex-rs/protocol/src/error.rs (CodexErr::retry_delay / to_codex_protocol_error)
 *        codex-rs/core/src/responses_retry.rs
 *        codex-rs/async-utils/src/backoff.rs
 *        codex-rs/codex-api/src/sse/responses_error.rs (parse_failed_response)
 *        codex-rs/codex-api/src/api_bridge.rs (HTTP status → CodexErr)
 *
 * Shared retry decisions for Responses API requests: what a failure IS (its
 * kind — the CodexErrorDetails arms codex-ts can reach), whether it may be
 * retried, and how long to wait before the next attempt.
 *
 * Unlike codex-rs (which can re-stream in place into a TUI), codex-ts emits
 * AgentMessageContentDelta events live, so the turn loop only retries failures
 * that happen BEFORE any visible output was streamed — see runTurn. The decision
 * helpers here are agnostic to that policy.
 */

// mirrors codex-rs async-utils/src/backoff.rs: INITIAL_DELAY_MS = 200,
// BACKOFF_FACTOR = 2.0, jitter uniform in [0.9, 1.1).
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

// ─── Failure kinds (mirrors CodexErrorDetails) ───────────────────────────────

/**
 * What a Responses failure is. Each kind mirrors the CodexErrorDetails arm
 * codex-rs maps the same HTTP status / SSE event to (api_bridge.rs,
 * sse/responses_error.rs, sse/responses.rs); the retry policy (retryDelayFor)
 * and the client-facing class (codexErrorInfoFor) both key off it, the way rs
 * keys both off CodexErrorDetails.
 *
 *   - `http`        a non-2xx response no rule below recognised — retried by
 *                   status (codex-rs retries those statuses in its HTTP client
 *                   before the turn loop sees them; codex-ts has one retry loop)
 *   - `stream`      CodexErr::Stream — an unrecognised `response.failed`, or a
 *                   stream that closed before `response.completed`
 *   - `content_filter`      `response.incomplete` with reason content_filter
 *   - `response_incomplete` any other `response.incomplete` (e.g.
 *                   max_output_tokens) — terminal since codex-rs #53451
 *   - the rest name the payload code that produced them.
 */
export type ResponsesFailureKind =
  | "http"
  | "stream"
  | "context_window_exceeded"
  | "quota_exceeded"
  | "usage_not_included"
  | "usage_limit_reached"
  | "cyber_policy"
  | "bio_policy"
  | "invalid_prompt"
  | "misalignment_policy_violation"
  | "rate_limit_exceeded"
  | "server_overloaded"
  | "flex_unavailable"
  | "content_filter"
  | "response_incomplete";

/** Kinds `retry_delay` maps to None — re-sending the same request cannot help. */
const TERMINAL_KINDS = new Set<ResponsesFailureKind>([
  "context_window_exceeded",
  "quota_exceeded",
  "usage_not_included",
  "usage_limit_reached",
  "cyber_policy",
  "bio_policy",
  "invalid_prompt",
  "misalignment_policy_violation",
  "flex_unavailable",
  "response_incomplete",
]);

/**
 * Token usage a `response.incomplete` reported. mirrors ResponseIncompleteError
 * (protocol/src/error.rs) — the response stopped early, but what it consumed is
 * still accounted (codex-rs #53670).
 */
export interface ResponseIncompleteDetails {
  reason: string;
  responseId?: string | undefined;
  /** The response's raw `usage` object, when it reported a valid one. */
  usage?: Record<string, unknown> | undefined;
}

export interface ResponsesApiErrorOptions {
  kind?: ResponsesFailureKind | undefined;
  /** Server-advised retry deadline (epoch ms), when known. */
  retryAt?: number | undefined;
  incomplete?: ResponseIncompleteDetails | undefined;
}

/**
 * A failed Responses request: a non-2xx response, or a terminal SSE event.
 *
 * `retryAt` is the server's retry advice as a DEADLINE, not a duration —
 * mirrors codex-rs's RetryAfter: the time spent after the response arrived
 * counts against it (`remaining_delay`), so a retry never sleeps longer than
 * the server asked. `retryAfterMs` is that advice as it stood when the error
 * was created (kept for hosts that read it).
 *
 * `terminal` marks a failure that must NOT be retried even though its status
 * would normally look transient — set by the caller, or implied by a terminal
 * `kind`.
 */
export class ResponsesApiError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | undefined;
  readonly retryAt: number | undefined;
  readonly terminal: boolean;
  readonly kind: ResponsesFailureKind;
  readonly incomplete: ResponseIncompleteDetails | undefined;

  constructor(
    status: number,
    body: string,
    retryAfterMs?: number | undefined,
    terminal = false,
    options: ResponsesApiErrorOptions = {},
  ) {
    super(`Responses API ${status}: ${body}`);
    this.name = "ResponsesApiError";
    this.status = status;
    this.retryAt =
      options.retryAt ??
      (retryAfterMs !== undefined ? Date.now() + retryAfterMs : undefined);
    this.retryAfterMs =
      retryAfterMs ??
      (this.retryAt !== undefined
        ? Math.max(0, this.retryAt - Date.now())
        : undefined);
    this.kind = options.kind ?? "http";
    this.terminal = terminal || TERMINAL_KINDS.has(this.kind);
    this.incomplete = options.incomplete;
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
//   - OpenRouter ENDPOINT pre-check (fires before any provider is tried, so
//     none of the provider wordings appear): "This endpoint's maximum context
//     length is N tokens. However, you requested about M tokens" — missing
//     this bricked the self-heal loop in prod (2026-07-18 a1d14926: a 1.42M
//     thread 400ed forever because setFull/compact never armed).
const CONTEXT_WINDOW_ERROR_RE =
  /context_length_exceeded|exceeds the context window|prompt is too long|exceeds the maximum number of tokens|input token count .{0,40}exceeds|maximum context length/iu;

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
    (error.kind === "context_window_exceeded" ||
      isContextWindowExceededText(error.message))
  );
}

/**
 * The server's remaining retry advice in ms, or undefined when it gave none.
 * mirrors CodexErr::server_retry_delay: expired advice stays present as zero
 * instead of falling back to a local delay.
 */
export function serverRetryDelay(error: unknown): number | undefined {
  if (!(error instanceof ResponsesApiError) || error.retryAt === undefined) {
    return undefined;
  }
  return Math.max(0, error.retryAt - Date.now());
}

/**
 * Delay before retry `attempt` (1-based), or undefined when the failure is
 * terminal. mirrors CodexErr::retry_delay (protocol/src/error.rs): terminal
 * kinds never retry; ServerOverloaded retries only on server advice; every
 * other retryable failure waits the server's advice when present, else the
 * exponential backoff. An interrupt is always terminal. Callers enforce their
 * own retry budgets.
 */
export function retryDelayFor(
  error: unknown,
  attempt: number,
): number | undefined {
  if (isAbortError(error)) {
    return undefined;
  }
  if (!(error instanceof ResponsesApiError)) {
    // A rejected fetch / dropped stream / JSON-IO error — rs CodexErr::Stream |
    // ConnectionFailed | Io | Json, all retryable.
    return backoff(attempt);
  }
  if (error.terminal || isContextWindowExceededError(error)) {
    return undefined;
  }
  const server = serverRetryDelay(error);
  switch (error.kind) {
    case "server_overloaded":
      return server;
    case "http":
      return isRetryableStatus(error.status)
        ? (server ?? backoff(attempt))
        : undefined;
    default:
      return server ?? backoff(attempt);
  }
}

/**
 * Classify a thrown error as retryable — `retryDelayFor` without the delay.
 * Aborts (interrupts) are terminal, as is any terminal kind; anything that is
 * not a ResponsesApiError (network TypeError, dropped stream, JSON/IO error) is
 * a transient connection failure.
 */
export function isRetryableError(error: unknown): boolean {
  return retryDelayFor(error, 1) !== undefined;
}

// ─── Error payload parsing (mirrors codex-api sse/responses_error.rs) ─────────

/**
 * Codes that mean "out of credits". mirrors parse_failed_response's
 * QuotaExceeded arm and the 429 `UsageErrorResponse` mapping (api_bridge.rs).
 */
const QUOTA_EXCEEDED_CODES = new Set<string>([
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
]);

/** mirrors rate_limit_regex (codex-api/src/sse/responses_error.rs) */
const RATE_LIMIT_RETRY_AFTER_RE =
  /try again in\s*(\d+(?:\.\d+)?)\s*(ms|s|seconds?)/i;

/**
 * Parse a provider "…please try again in 11.054s" hint into milliseconds.
 * mirrors try_parse_retry_delay (codex-api/src/sse/responses_error.rs), which
 * is only consulted for rate limits (`rate_limit_exceeded` / `slow_down`).
 */
export function parseRateLimitRetryAfterMs(
  code: string | undefined,
  message: string | undefined,
): number | undefined {
  if ((code !== "rate_limit_exceeded" && code !== "slow_down") || !message) {
    return undefined;
  }
  const match = RATE_LIMIT_RETRY_AFTER_RE.exec(message);
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value)) {
    return undefined;
  }
  const unit = (match[2] ?? "").toLowerCase();
  return unit === "ms" ? Math.round(value) : Math.round(value * 1000);
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Headers carried INSIDE a failed event (`response.error.headers`, a JSON
 * object) as a Headers instance. mirrors json_headers_to_http_headers
 * (codex-api/src/responses_headers.rs).
 */
function headersOf(value: unknown): Headers | undefined {
  const record = recordOf(value);
  if (!record) {
    return undefined;
  }
  const headers = new Headers();
  for (const [name, raw] of Object.entries(record)) {
    const text =
      typeof raw === "string"
        ? raw
        : typeof raw === "number"
          ? String(raw)
          : Array.isArray(raw) && typeof raw[0] === "string"
            ? raw[0]
            : undefined;
    if (text !== undefined) {
      try {
        headers.set(name, text);
      } catch {
        // An invalid header name / value — skip it, like rs drops it.
      }
    }
  }
  return headers;
}

/** The failure kind an error object's `code` / `type` names, if any. */
function kindOfErrorCode(
  code: string | undefined,
  type: string | undefined,
): ResponsesFailureKind | undefined {
  if (code === "context_length_exceeded") return "context_window_exceeded";
  if (code === "flex_unavailable") return "flex_unavailable";
  if (code !== undefined && QUOTA_EXCEEDED_CODES.has(code)) {
    return "quota_exceeded";
  }
  if (type === "insufficient_quota") return "quota_exceeded";
  if (code === "usage_not_included" || type === "usage_not_included") {
    return "usage_not_included";
  }
  if (type === "usage_limit_reached") return "usage_limit_reached";
  if (code === "cyber_policy") return "cyber_policy";
  if (code === "bio_policy") return "bio_policy";
  if (code === "misalignment_policy_violation") {
    return "misalignment_policy_violation";
  }
  if (code === "invalid_prompt") return "invalid_prompt";
  if (code === "server_is_overloaded") return "server_overloaded";
  if (code === "rate_limit_exceeded" || code === "slow_down") {
    return "rate_limit_exceeded";
  }
  return undefined;
}

// ─── SSE terminal-event classification (mirrors codex-api sse/responses*.rs) ──

/**
 * Turn a terminal SSE event into a ResponsesApiError with the same retry
 * verdict codex-rs would reach.
 *
 *   - `response.failed` → parse_failed_response (sse/responses_error.rs):
 *     the error's `code` picks the kind; a Retry-After inside the event
 *     (`response.error.headers`) is honored for every retryable kind, and a
 *     rate limit falls back to its "try again in Xs" hint. An event without a
 *     parsable error object stays a retryable stream error.
 *   - `response.incomplete` → process_responses_event (sse/responses.rs):
 *     reason `content_filter` is a retryable ContentFilter; any other reason
 *     (max_output_tokens…) is a TERMINAL ResponseIncomplete carrying the
 *     response's usage (codex-rs #53451 / #53670). Reason `interrupted` is not
 *     a failure at all — runTurn treats it as `response.completed` with
 *     `end_turn: false` and never calls this.
 *   - an `error` event naming `flex_unavailable` (sse/responses.rs:349).
 *
 * The 503 status is a stand-in for "stream-level failure, no HTTP status".
 */
export function classifyStreamFailure(
  raw: Record<string, unknown>,
): ResponsesApiError {
  const eventType = String(raw["type"] ?? "");
  const response = recordOf(raw["response"]);

  if (eventType === "response.incomplete") {
    const details = recordOf(response?.["incomplete_details"]);
    const reason = stringOf(details?.["reason"]) ?? "unknown";
    const message = `Incomplete response returned, reason: ${reason}`;
    if (reason === "content_filter") {
      return new ResponsesApiError(503, message, undefined, false, {
        kind: "content_filter",
      });
    }
    return new ResponsesApiError(503, message, undefined, true, {
      kind: "response_incomplete",
      incomplete: {
        reason,
        responseId: stringOf(response?.["id"]),
        usage: recordOf(response?.["usage"]),
      },
    });
  }

  const error = recordOf(
    eventType === "error" ? raw["error"] : response?.["error"],
  );
  const code = stringOf(error?.["code"]);
  const message = stringOf(error?.["message"]);
  const body =
    error !== undefined ? JSON.stringify(error) : JSON.stringify(raw);
  const headerRetryAfterMs = (() => {
    const headers = headersOf(error?.["headers"]);
    return headers ? parseRetryAfter(headers) : undefined;
  })();

  const kind = kindOfErrorCode(code, stringOf(error?.["type"])) ?? "stream";
  const retryAfterMs =
    headerRetryAfterMs ??
    (kind === "rate_limit_exceeded"
      ? parseRateLimitRetryAfterMs(code, message)
      : undefined);
  return new ResponsesApiError(503, body, retryAfterMs, false, { kind });
}

/**
 * Turn a non-2xx Responses response into a ResponsesApiError. mirrors
 * map_api_error's TransportError::Http arm (codex-api/src/api_bridge.rs):
 *   - 503 `server_is_overloaded` → ServerOverloaded (retried only on server
 *     advice); 503 `slow_down` → RateLimitExceeded;
 *   - 400/403 `misalignment_policy_violation`, 400 `cyber_policy` /
 *     `bio_policy` / `invalid_prompt` → their terminal kinds;
 *   - 429 `flex_unavailable` → FlexUnavailable; 429 `usage_limit_reached` /
 *     `usage_not_included` / insufficient quota → terminal usage kinds;
 *   - anything else stays `http`, retried by status.
 * The Retry-After header is the server's advice for every retryable kind.
 */
export function classifyHttpFailure(
  status: number,
  body: string,
  headers: Headers,
): ResponsesApiError {
  const retryAfterMs = parseRetryAfter(headers);
  let error: Record<string, unknown> | undefined;
  try {
    error = recordOf(recordOf(JSON.parse(body))?.["error"]);
  } catch {
    error = undefined;
  }
  const code = stringOf(error?.["code"]);
  const type = stringOf(error?.["type"]);
  let kind: ResponsesFailureKind = "http";
  if (status === 503 && code === "server_is_overloaded") {
    kind = "server_overloaded";
  } else if (status === 503 && code === "slow_down") {
    kind = "rate_limit_exceeded";
  } else if (
    (status === 400 || status === 403) &&
    code === "misalignment_policy_violation"
  ) {
    kind = "misalignment_policy_violation";
  } else if (
    status === 400 &&
    (code === "cyber_policy" ||
      code === "bio_policy" ||
      code === "invalid_prompt")
  ) {
    kind = code;
  } else if (status === 429) {
    if (code === "flex_unavailable") {
      kind = "flex_unavailable";
    } else if (type === "usage_limit_reached") {
      kind = "usage_limit_reached";
    } else if (type === "usage_not_included") {
      kind = "usage_not_included";
    } else if (
      type === "insufficient_quota" ||
      (code !== undefined && QUOTA_EXCEEDED_CODES.has(code))
    ) {
      kind = "quota_exceeded";
    }
  }
  return new ResponsesApiError(status, body, retryAfterMs, false, { kind });
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

/**
 * Delay before the next attempt: the server's advice when the error carries
 * one, otherwise exponential backoff. Unlike retryDelayFor this never says
 * "terminal" — callers that need that verdict use retryDelayFor.
 */
export function computeRetryDelay(error: unknown, attempt: number): number {
  return (
    retryDelayFor(error, attempt) ?? serverRetryDelay(error) ?? backoff(attempt)
  );
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

// ─── Content-filter recovery guidance (mirrors core/src/responses_retry.rs) ───

/**
 * mirrors CONTENT_FILTER_GUIDANCE (codex-rs/prompts/src/model_messages.rs:59),
 * the bounded recovery guidance codex-rs records before re-sampling a response
 * a content filter blocked.
 */
export const CONTENT_FILTER_GUIDANCE =
  "Your previous response was blocked by a content filter. Do not treat this as a transient failure or try to reproduce or work around the blocked content through repeated attempts, altered formatting, splitting, encoding, tools, subagents, or later wakes. Briefly explain the limitation and offer a permitted alternative. Continue unrelated authorized work.";

/**
 * The guidance as rendered by codex-rs's ContentFilterGuidance fragment
 * (core/src/context/content_filter_guidance.rs): the text between
 * `<content_filter_guidance>` markers.
 */
export function renderContentFilterGuidance(): string {
  return `<content_filter_guidance>\n${CONTENT_FILTER_GUIDANCE}\n</content_filter_guidance>`;
}

// ─── Client-facing error classification (mirrors to_codex_protocol_error) ─────

/**
 * Classify a thrown error into the protocol's CodexErrorInfo so hosts can branch
 * on the error class instead of matching message text.
 *
 * mirrors CodexErr::to_codex_protocol_error (protocol/src/error.rs) fed by the
 * HTTP/SSE mapping in codex-api (api_bridge.rs, sse/responses_error.rs). Only
 * the arms codex-ts can actually reach are produced; note how much rs still
 * funnels into `Other` — `InvalidRequest` (a plain 400), `Stream` (network
 * failure, dropped stream, unrecognised `response.failed`), ContentFilter,
 * ResponseIncomplete and RequestTimeout all hit its `_ => Other` arm, so
 * codex-ts must not invent finer classes for them.
 */
export function codexErrorInfoFor(
  error: unknown,
): import("../../../protocol/src/protocol.js").CodexErrorInfo {
  if (isContextWindowExceededError(error)) {
    return { type: "context_window_exceeded" };
  }
  if (!(error instanceof ResponsesApiError)) {
    // A rejected fetch / dropped stream — rs TransportError::Network|Timeout →
    // CodexErr::Stream|RequestTimeout → Other.
    return { type: "other" };
  }

  switch (error.kind) {
    case "cyber_policy":
      return { type: "cyber_policy" };
    case "bio_policy":
      return { type: "bio_policy" };
    case "invalid_prompt":
      return { type: "invalid_prompt" };
    case "misalignment_policy_violation":
      return { type: "misalignment_policy_violation" };
    case "rate_limit_exceeded":
      return { type: "rate_limit_exceeded" };
    case "server_overloaded":
      return { type: "server_overloaded" };
    case "flex_unavailable":
      return { type: "flex_unavailable" };
    // QuotaExceeded | UsageNotIncluded | UsageLimitReached all collapse into
    // UsageLimitExceeded (error.rs).
    case "quota_exceeded":
    case "usage_not_included":
    case "usage_limit_reached":
      return { type: "usage_limit_exceeded" };
    case "stream":
    case "content_filter":
    case "response_incomplete":
    case "context_window_exceeded":
      return { type: "other" };
    case "http":
      break;
  }

  switch (error.status) {
    // A plain 400 → CodexErr::InvalidRequest → Other.
    case 400:
      return { type: "other" };
    // 429 → CodexErr::RetryLimit → ResponseTooManyFailedAttempts.
    case 429:
      return {
        type: "response_too_many_failed_attempts",
        http_status_code: error.status,
      };
    // 500 → CodexErr::InternalServerError.
    case 500:
      return { type: "internal_server_error" };
    // Any other status → CodexErr::UnexpectedStatus → HttpConnectionFailed.
    default:
      return { type: "http_connection_failed", http_status_code: error.status };
  }
}

/**
 * Abortable sleep. Rejects with an AbortError if the signal fires first, so a
 * mid-backoff interrupt cancels the turn promptly.
 */
export function sleep(
  ms: number,
  signal?: AbortSignal | undefined,
): Promise<void> {
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

/**
 * Wait for `work`, but give up the moment `signal` aborts (rejecting with an
 * AbortError). The work itself keeps running — a promise cannot be cancelled —
 * and whatever it settles with afterwards is dropped.
 *
 * mirrors the select! in ToolCallRuntime::handle_tool_call_with_source
 * (core/src/tools/parallel.rs): codex-rs races a tool's task against the
 * turn's cancellation token and stops waiting as soon as it fires (then aborts
 * the task; JavaScript can only stop listening).
 */
export function untilAborted<T>(
  work: Promise<T>,
  signal?: AbortSignal | undefined,
): Promise<T> {
  if (!signal) {
    return work;
  }
  if (signal.aborted) {
    // Swallow a late rejection: nothing is waiting for it any more.
    work.catch(() => undefined);
    return Promise.reject(new DOMException("Turn interrupted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new DOMException("Turn interrupted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
