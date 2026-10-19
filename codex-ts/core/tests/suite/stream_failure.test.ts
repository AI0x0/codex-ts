/**
 * mirrors codex-api/src/sse/responses.rs process_responses_event's terminal arms
 * (`response.failed` via sse/responses_error.rs parse_failed_response,
 * `response.incomplete`, `error`) + CodexErr::retry_delay
 * (protocol/src/error.rs) + api_bridge.rs's HTTP mapping + the turn lifecycle
 * in tasks/mod.rs:795-813.
 *
 * Covers what an SSE-level failure does to a turn: which payload codes are
 * terminal, which are retried (and with what delay), and the fact that a failed
 * turn still completes its lifecycle with the error attached.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { CodexThread } from "../../src/codex_thread.js";
import {
  classifyHttpFailure,
  classifyStreamFailure,
  codexErrorInfoFor,
  isRetryableError,
  parseRateLimitRetryAfterMs,
  retryDelayFor,
} from "../../src/session/retry.js";
import type { ConversationItem } from "../../../thread-store/src/types.js";
import type { ErrorEvent } from "../../../protocol/src/protocol.js";
import {
  evAssistantMessage,
  evCompleted,
  evResponseCreated,
  makeSseResponse,
  sseFlat,
  waitForEvent,
  waitForEventMatch,
} from "../common/lib.js";

function okSse(): Response {
  return makeSseResponse(
    sseFlat([evResponseCreated("r1"), evAssistantMessage("ok"), evCompleted("r1")]),
  );
}

function failedSse(error: Record<string, unknown>): Response {
  return makeSseResponse(
    sseFlat([
      evResponseCreated("r1"),
      { type: "response.failed", response: { id: "r1", status: "failed", error } },
    ]),
  );
}

function incompleteSse(
  reason: string,
  usage?: Record<string, unknown>,
  partialText?: string,
): Response {
  return makeSseResponse(
    sseFlat([
      evResponseCreated("r1"),
      ...(partialText ? [evAssistantMessage(partialText)] : []),
      {
        type: "response.incomplete",
        response: {
          id: "r1",
          status: "incomplete",
          incomplete_details: { reason },
          ...(usage ? { usage } : {}),
        },
      },
    ]),
  );
}

function errorResponse(status: number, body: object, headers?: HeadersInit): Response {
  const text = JSON.stringify(body);
  return {
    ok: false,
    status,
    headers: new Headers(headers),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
    text: async () => text,
  } as unknown as Response;
}

function inputOf(call: unknown[]): ConversationItem[] {
  return (JSON.parse((call[1] as RequestInit).body as string) as {
    input: ConversationItem[];
  }).input;
}

function thread(fetchMock: typeof fetch, maxRetries = 3): CodexThread {
  return new CodexThread({
    apiKey: "k",
    baseUrl: "https://example.test/v1",
    fetch: fetchMock,
    model: "m",
    maxRetries,
  });
}

describe("classifyStreamFailure", () => {
  it("marks quota / policy / flex codes terminal", () => {
    // Exactly the codes parse_failed_response maps to CodexErr variants whose
    // retry_delay is None. `usage_limit_reached` is NOT here — rs classifies
    // that one on the HTTP 429 path (api_bridge.rs), not from an SSE payload.
    for (const code of [
      "insufficient_quota",
      "credit_balance_exhausted",
      "organization_spend_limit_exceeded",
      "project_spend_limit_exceeded",
      "usage_not_included",
      "cyber_policy",
      "invalid_prompt",
      "bio_policy",
      "misalignment_policy_violation",
      "flex_unavailable",
    ]) {
      const err = classifyStreamFailure({
        type: "response.failed",
        response: { error: { code, message: "nope" } },
      });
      expect(err.terminal, code).toBe(true);
      expect(isRetryableError(err), code).toBe(false);
    }
  });

  it("keeps unrecognised failures retryable (rs defaults to ApiError::Retryable)", () => {
    const err = classifyStreamFailure({
      type: "response.failed",
      response: { error: { code: "something_new", message: "boom" } },
    });
    expect(err.terminal).toBe(false);
    expect(isRetryableError(err)).toBe(true);
  });

  it("honors a rate-limit 'try again in Xs' hint", () => {
    const err = classifyStreamFailure({
      type: "response.failed",
      response: {
        error: {
          code: "rate_limit_exceeded",
          message: "Rate limit reached. Please try again in 1.5s. See docs.",
        },
      },
    });
    expect(err.retryAfterMs).toBe(1500);
    expect(isRetryableError(err)).toBe(true);
  });

  it("parses the hint only for rate limits", () => {
    expect(
      parseRateLimitRetryAfterMs("rate_limit_exceeded", "try again in 250ms"),
    ).toBe(250);
    expect(
      parseRateLimitRetryAfterMs("rate_limit_exceeded", "try again in 3 seconds"),
    ).toBe(3000);
    expect(parseRateLimitRetryAfterMs("slow_down", "try again in 2s")).toBe(2000);
    expect(
      parseRateLimitRetryAfterMs("server_error", "try again in 3s"),
    ).toBeUndefined();
  });

  it("treats slow_down as a retryable rate limit (no longer as overload)", () => {
    const err = classifyStreamFailure({
      type: "response.failed",
      response: { error: { code: "slow_down", message: "try again in 2s" } },
    });
    expect(err.kind).toBe("rate_limit_exceeded");
    expect(err.retryAfterMs).toBe(2000);
    expect(isRetryableError(err)).toBe(true);
    expect(codexErrorInfoFor(err)).toEqual({ type: "rate_limit_exceeded" });
  });

  it("retries server_is_overloaded only on server advice", () => {
    const bare = classifyStreamFailure({
      type: "response.failed",
      response: { error: { code: "server_is_overloaded", message: "busy" } },
    });
    expect(retryDelayFor(bare, 1)).toBeUndefined();
    expect(codexErrorInfoFor(bare)).toEqual({ type: "server_overloaded" });

    // The Retry-After a failed event carries inside `response.error.headers`.
    const advised = classifyStreamFailure({
      type: "response.failed",
      response: {
        error: {
          code: "server_is_overloaded",
          message: "busy",
          headers: { "retry-after": "2" },
        },
      },
    });
    const delay = retryDelayFor(advised, 1) ?? -1;
    expect(delay).toBeGreaterThan(1900);
    expect(delay).toBeLessThanOrEqual(2000);
  });

  it("keeps a failed event without an error object retryable", () => {
    const err = classifyStreamFailure({ type: "response.failed", response: {} });
    expect(err.kind).toBe("stream");
    expect(isRetryableError(err)).toBe(true);
  });

  it("response.incomplete: content_filter retries, any other reason is terminal and keeps its usage", () => {
    const filtered = classifyStreamFailure({
      type: "response.incomplete",
      response: { incomplete_details: { reason: "content_filter" } },
    });
    expect(filtered.kind).toBe("content_filter");
    expect(isRetryableError(filtered)).toBe(true);

    const usage = { input_tokens: 120, output_tokens: 4000, total_tokens: 4120 };
    const truncated = classifyStreamFailure({
      type: "response.incomplete",
      response: {
        id: "r9",
        incomplete_details: { reason: "max_output_tokens" },
        usage,
      },
    });
    expect(truncated.message).toContain(
      "Incomplete response returned, reason: max_output_tokens",
    );
    expect(truncated.kind).toBe("response_incomplete");
    expect(isRetryableError(truncated)).toBe(false);
    expect(truncated.incomplete).toEqual({
      reason: "max_output_tokens",
      responseId: "r9",
      usage,
    });
    expect(codexErrorInfoFor(truncated)).toEqual({ type: "other" });
  });
});

describe("classifyHttpFailure", () => {
  it("maps payload codes the way api_bridge.rs does", () => {
    const overloaded = classifyHttpFailure(
      503,
      JSON.stringify({ error: { code: "server_is_overloaded" } }),
      new Headers(),
    );
    expect(retryDelayFor(overloaded, 1)).toBeUndefined();

    const slow = classifyHttpFailure(
      503,
      JSON.stringify({ error: { code: "slow_down", message: "slow" } }),
      new Headers(),
    );
    expect(slow.kind).toBe("rate_limit_exceeded");
    expect(isRetryableError(slow)).toBe(true);

    const flex = classifyHttpFailure(
      429,
      JSON.stringify({ error: { code: "flex_unavailable" } }),
      new Headers(),
    );
    expect(isRetryableError(flex)).toBe(false);
    expect(codexErrorInfoFor(flex)).toEqual({ type: "flex_unavailable" });

    const quota = classifyHttpFailure(
      429,
      JSON.stringify({ error: { type: "insufficient_quota" } }),
      new Headers(),
    );
    expect(isRetryableError(quota)).toBe(false);
    expect(codexErrorInfoFor(quota)).toEqual({ type: "usage_limit_exceeded" });

    const bio = classifyHttpFailure(
      400,
      JSON.stringify({ error: { code: "bio_policy" } }),
      new Headers(),
    );
    expect(codexErrorInfoFor(bio)).toEqual({ type: "bio_policy" });
    const prompt = classifyHttpFailure(
      400,
      JSON.stringify({ error: { code: "invalid_prompt" } }),
      new Headers(),
    );
    expect(codexErrorInfoFor(prompt)).toEqual({ type: "invalid_prompt" });
  });

  it("keeps a plain 429 / 5xx retryable and classifies other statuses as HttpConnectionFailed", () => {
    const limited = classifyHttpFailure(429, "Too Many Requests", new Headers({ "retry-after": "1" }));
    expect(isRetryableError(limited)).toBe(true);
    expect(codexErrorInfoFor(limited)).toEqual({
      type: "response_too_many_failed_attempts",
      http_status_code: 429,
    });
    expect(isRetryableError(classifyHttpFailure(502, "bad gateway", new Headers()))).toBe(true);
    const unauthorized = classifyHttpFailure(401, "unauthorized", new Headers());
    expect(isRetryableError(unauthorized)).toBe(false);
    expect(codexErrorInfoFor(unauthorized)).toEqual({
      type: "http_connection_failed",
      http_status_code: 401,
    });
    expect(codexErrorInfoFor(classifyHttpFailure(400, "bad", new Headers()))).toEqual({
      type: "other",
    });
  });
});

describe("turn behaviour on stream failures", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not retry a terminal response.failed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      failedSse({ code: "insufficient_quota", message: "out of credits" }),
    );

    const codex = thread(fetchMock as unknown as typeof fetch);
    await codex.submit({ items: [{ text: "hi", type: "text" }], type: "UserInput" });
    const error = await waitForEventMatch(codex, (msg) =>
      msg.type === "Error" ? msg.event : null,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.codex_error_info).toEqual({ type: "usage_limit_exceeded" });
  });

  it("retries a retryable response.failed then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        failedSse({ code: "rate_limit_exceeded", message: "try again in 10ms" }),
      )
      .mockResolvedValue(okSse());

    const codex = thread(fetchMock as unknown as typeof fetch);
    await codex.submit({ items: [{ text: "hi", type: "text" }], type: "UserInput" });
    await waitForEvent(codex, (m) => m.type === "TurnComplete");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // mirrors handle_response_stream_error (core/src/responses_retry.rs): a
  // content-filtered response is re-sampled with recovery guidance.
  it("retries a content-filtered response with the recovery guidance", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(incompleteSse("content_filter"))
      .mockResolvedValue(okSse());

    const codex = thread(fetchMock as unknown as typeof fetch);
    await codex.submit({ items: [{ text: "hi", type: "text" }], type: "UserInput" });
    await waitForEvent(codex, (m) => m.type === "TurnComplete");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(inputOf(fetchMock.mock.calls[0]!))).not.toContain(
      "content_filter_guidance",
    );
    const retried = inputOf(fetchMock.mock.calls[1]!);
    expect(retried.at(-1)).toEqual({
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: expect.stringMatching(
            /^<content_filter_guidance>\nYour previous response was blocked by a content filter\..*\n<\/content_filter_guidance>$/su,
          ),
        },
      ],
    });
  });

  // codex-rs #53451 / #53670: an incomplete response (max_output_tokens…) is
  // terminal — no retry — but what it consumed is still reported.
  it("ends the turn on a truncated response without retrying, still reporting its usage", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      incompleteSse("max_output_tokens", {
        input_tokens: 321,
        output_tokens: 4000,
        total_tokens: 4321,
      }),
    );

    const codex = thread(fetchMock as unknown as typeof fetch);
    await codex.submit({ items: [{ text: "hi", type: "text" }], type: "UserInput" });
    const tokens = await waitForEventMatch(codex, (msg) =>
      msg.type === "TokenCount" ? msg.event : null,
    );
    const error = await waitForEventMatch(codex, (msg) =>
      msg.type === "Error" ? msg.event : null,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tokens.info?.last_token_usage.input_tokens).toBe(321);
    expect(error.message).toContain("reason: max_output_tokens");
    expect(error.codex_error_info).toEqual({ type: "other" });
  });

  // sse/responses.rs: an incomplete response interrupted server-side is a
  // completed response with `end_turn: false` — the turn samples again.
  it("samples again after a response the server interrupted", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(incompleteSse("interrupted", undefined, "partial"))
      .mockResolvedValue(okSse());

    const codex = thread(fetchMock as unknown as typeof fetch);
    await codex.submit({ items: [{ text: "hi", type: "text" }], type: "UserInput" });
    const complete = await waitForEventMatch(codex, (msg) =>
      msg.type === "TurnComplete" ? msg.event : null,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(complete.error).toBeUndefined();
    // The partial message stays in history ahead of the follow-up request.
    expect(JSON.stringify(inputOf(fetchMock.mock.calls[1]!))).toContain("partial");
  });

  it("samples again when response.completed says end_turn: false", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeSseResponse(
          sseFlat([
            evResponseCreated("r1"),
            evAssistantMessage("first half"),
            {
              type: "response.completed",
              response: { id: "r1", status: "completed", end_turn: false },
            },
          ]),
        ),
      )
      .mockResolvedValue(okSse());

    const codex = thread(fetchMock as unknown as typeof fetch);
    await codex.submit({ items: [{ text: "hi", type: "text" }], type: "UserInput" });
    await waitForEvent(codex, (m) => m.type === "TurnComplete");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 503 server_is_overloaded without Retry-After", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        errorResponse(503, { error: { code: "server_is_overloaded", message: "busy" } }),
      );

    const codex = thread(fetchMock as unknown as typeof fetch);
    await codex.submit({ items: [{ text: "hi", type: "text" }], type: "UserInput" });
    const error = await waitForEventMatch(codex, (msg) =>
      msg.type === "Error" ? msg.event : null,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.codex_error_info).toEqual({ type: "server_overloaded" });
  });

  it("ends the turn on a Flex capacity error event", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeSseResponse(
        sseFlat([
          evResponseCreated("r1"),
          { type: "error", error: { code: "flex_unavailable", message: "no capacity" } },
        ]),
      ),
    );

    const codex = thread(fetchMock as unknown as typeof fetch);
    await codex.submit({ items: [{ text: "hi", type: "text" }], type: "UserInput" });
    const error = await waitForEventMatch(codex, (msg) =>
      msg.type === "Error" ? msg.event : null,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.codex_error_info).toEqual({ type: "flex_unavailable" });
  });

  // mirrors tasks/mod.rs:795-813 — a failed turn emits Error AND completes the
  // turn lifecycle with the terminal error attached, so hosts awaiting
  // TurnComplete are never left hanging.
  it("still completes the turn, carrying the error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      failedSse({ code: "cyber_policy", message: "flagged" }),
    );

    const codex = thread(fetchMock as unknown as typeof fetch);
    await codex.submit({ items: [{ text: "hi", type: "text" }], type: "UserInput" });
    const complete = await waitForEventMatch(codex, (msg) =>
      msg.type === "TurnComplete" ? msg.event : null,
    );

    const error = complete.error as ErrorEvent;
    expect(error.codex_error_info).toEqual({ type: "cyber_policy" });
    expect(error.message).toContain("cyber_policy");
    expect(complete.duration_ms).toBeGreaterThanOrEqual(0);
    expect(complete.started_at).toBeGreaterThan(0);
  });

  // mirrors tasks/mod.rs:785-794: an aborted turn ends with TurnAborted, not
  // TurnComplete.
  it("ends an interrupted turn with TurnAborted", async () => {
    // A never-resolving request so the turn is still in flight when interrupted.
    const fetchMock = vi.fn().mockImplementation(
      () => new Promise<Response>(() => {}),
    );

    const codex = thread(fetchMock as unknown as typeof fetch);
    await codex.submit({ items: [{ text: "hi", type: "text" }], type: "UserInput" });
    await codex.submit({ type: "Interrupt" });

    const aborted = await waitForEventMatch(codex, (msg) =>
      msg.type === "TurnAborted" ? msg.event : null,
    );
    expect(aborted.reason).toBe("interrupted");
    expect(aborted.root_turn_id).toBe(aborted.turn_id);
    expect(aborted.started_at).toBeGreaterThan(0);
    expect(aborted.duration_ms).toBeGreaterThanOrEqual(0);
  });
});
