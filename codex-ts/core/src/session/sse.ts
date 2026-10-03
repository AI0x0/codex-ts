/**
 * SSE stream parser for the OpenAI Responses API.
 * Extracted from turn.ts so compact.ts can share it.
 *
 * mirrors codex-rs: codex-api/src/sse/responses.rs reads the body through the
 * `eventsource-stream` crate (`stream.eventsource()`), which follows the SSE spec
 * (https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation).
 * This port used to match only `data: ` (with the space) and to reset its data
 * buffer on every network read, so it silently dropped:
 *   · every event of an upstream that writes `data:{…}` — legal SSE; a DeepSeek
 *     gateway behind Aihubmix switched to it on 2026-10-03 and whole turns came
 *     back empty: no text, no tool calls, no error;
 *   · any event whose `data:` line and closing blank line arrived in two reads.
 *
 * The spec rules kept here:
 *   · a line ends in CRLF, LF or CR;
 *   · a blank line dispatches the event; a line starting with ":" is a comment;
 *   · `field:value` drops one leading space of the value; the `data` lines of one
 *     event are joined with "\n". The other fields (event / id / retry) are not
 *     needed: callers dispatch on the JSON payload's `type`.
 * One deliberate leniency: data still pending when the body ends is dispatched
 * (the spec discards it), so an upstream that leaves out the final blank line
 * does not lose its last event — usually response.completed.
 */

export type RawSseEvent = Record<string, unknown>;

interface ParseState {
  /** The `data` lines of the event being read; kept across network reads. */
  data: string[];
}

function isRecord(value: unknown): value is RawSseEvent {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The event the pending `data` lines make up (the lines are cleared either way). */
function dispatch(state: ParseState): RawSseEvent | undefined {
  if (state.data.length === 0) return undefined;
  const data = state.data.join("\n");
  state.data = [];
  if (data === "[DONE]") return undefined;
  try {
    const parsed: unknown = JSON.parse(data);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    /* malformed JSON — skip */
    return undefined;
  }
}

/** One line (without its line ending); returns the event a blank line dispatches. */
function takeLine(state: ParseState, line: string): RawSseEvent | undefined {
  if (line === "") return dispatch(state);
  if (line.startsWith(":")) return undefined;
  const colon = line.indexOf(":");
  const field = colon < 0 ? line : line.slice(0, colon);
  if (field !== "data") return undefined;
  const value = colon < 0 ? "" : line.slice(colon + 1);
  state.data.push(value.startsWith(" ") ? value.slice(1) : value);
  return undefined;
}

export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<RawSseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  // Local, not module-level: two streams parsed at once must not share lastIndex.
  const lineEnd = /\r\n|\n|\r/gu;
  const state: ParseState = { data: [] };
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      let start = 0;
      lineEnd.lastIndex = 0;
      for (
        let match = lineEnd.exec(buffer);
        match;
        match = lineEnd.exec(buffer)
      ) {
        // A "\r" at the very end may be the first half of "\r\n": wait for the next read.
        if (!done && match[0] === "\r" && match.index === buffer.length - 1) {
          break;
        }
        const event = takeLine(state, buffer.slice(start, match.index));
        start = match.index + match[0].length;
        if (event) yield event;
      }
      buffer = buffer.slice(start);
      if (done) {
        // The lenient end (see the header): the last line and its event still count.
        const last = buffer ? takeLine(state, buffer) : undefined;
        if (last) yield last;
        const pending = dispatch(state);
        if (pending) yield pending;
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
