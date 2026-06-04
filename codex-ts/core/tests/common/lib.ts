/**
 * mirrors codex-rs/core/tests/common/lib.rs
 *
 * Shared test helpers: waitForEvent, mock SSE server helpers.
 */

import type { EventMsg } from "../../../protocol/src/protocol.js";
import type { CodexThread } from "../../src/codex_thread.js";

// ─── waitForEvent ─────────────────────────────────────────────────────────────

/**
 * Mirrors wait_for_event() in core_test_support.
 * Polls nextEvent() until predicate returns true, then returns that EventMsg.
 */
export async function waitForEvent(
  codex: CodexThread,
  predicate: (msg: EventMsg) => boolean,
  timeoutMs = 2000,
): Promise<EventMsg> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(`waitForEvent timed out after ${timeoutMs}ms`);
    }
    const event = await Promise.race([
      codex.nextEvent(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), timeoutMs),
      ),
    ]);
    if (predicate(event.msg)) return event.msg;
  }
}

/**
 * Mirrors wait_for_event_match() — extracts a typed value from the matching event.
 */
export async function waitForEventMatch<T>(
  codex: CodexThread,
  matcher: (msg: EventMsg) => T | null,
  timeoutMs = 2000,
): Promise<T> {
  const msg = await waitForEvent(codex, (m) => matcher(m) !== null, timeoutMs);
  return matcher(msg) as T;
}

// ─── SSE mock helpers (mirrors core_test_support/responses.rs) ────────────────

/** Build a raw SSE data payload string from an array of event objects */
export function sse(events: object[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

export function evResponseCreated(id: string): object {
  return { type: "response.created", response: { id, status: "in_progress" } };
}

export function evFunctionCall(
  callId: string,
  name: string,
  args: object,
): object {
  const argsStr = JSON.stringify(args);
  return [
    {
      type: "response.output_item.added",
      item: { type: "function_call", call_id: callId, name },
    },
    {
      type: "response.function_call_arguments.delta",
      call_id: callId,
      delta: argsStr,
    },
    {
      type: "response.output_item.done",
      item: { type: "function_call", call_id: callId, name, arguments: argsStr },
    },
  ];
}

export function evAssistantMessage(text: string): object {
  return [
    {
      type: "response.output_item.added",
      item: { id: "msg-1", type: "message", status: "in_progress", content: [] },
    },
    { type: "response.output_text.delta", delta: text },
    { type: "response.output_text.done", text },
    {
      type: "response.output_item.done",
      item: {
        id: "msg-1",
        type: "message",
        content: [{ type: "output_text", text }],
      },
    },
  ];
}

export function evCompleted(id: string): object {
  return { type: "response.done", response: { id, status: "completed" } };
}

/** Flatten nested arrays of SSE events into a single SSE string */
export function sseFlat(events: (object | object[])[]): string {
  return sse(events.flat());
}

// ─── Mock fetch ───────────────────────────────────────────────────────────────

export function makeSseResponse(sseText: string): Response {
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseText));
        controller.close();
      },
    }),
    text: async () => sseText,
  } as unknown as Response;
}
