/**
 * mirror codex-rs: the Responses stream is parsed per the SSE spec, as the
 * `eventsource-stream` crate does for codex-api/src/sse/responses.rs.
 *
 * Before this fix parseSseStream matched only `data: ` (with the space) and reset
 * its data buffer on every network read. On 2026-10-03 a DeepSeek gateway behind
 * Aihubmix started writing `id:1` / `event:…` / `:HTTP_STATUS/200` / `data:{…}` —
 * legal SSE, but this port saw no events at all: the model's tool calls were never
 * run, and the turn ended empty without an error.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { CodexThread } from "../../src/codex_thread.js";
import { parseSseStream } from "../../src/session/sse.js";
import type { CustomTool } from "../../src/tools/router.js";
import {
  evAssistantMessage,
  evCompleted,
  evResponseCreated,
  makeSseResponse,
  sseFlat,
  waitForEvent,
} from "../common/lib.js";

/** The stream cut into reads at these byte offsets (a cut may fall inside a line). */
function chunked(
  text: string,
  cuts: number[] = [],
): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const edges = [0, ...cuts, bytes.length];
  return new ReadableStream({
    start(controller) {
      for (let index = 1; index < edges.length; index += 1) {
        controller.enqueue(bytes.slice(edges[index - 1], edges[index]));
      }
      controller.close();
    },
  });
}

async function eventsOf(body: ReadableStream<Uint8Array>): Promise<object[]> {
  const events: object[] = [];
  for await (const event of parseSseStream(body)) events.push(event);
  return events;
}

/** The 2026-10-03 gateway's framing: no space after the colons, plus id / event / a comment. */
function bare(events: object[]): string {
  return events
    .map(
      (event, index) =>
        `id:${index + 1}\nevent:${(event as { type: string }).type}\n:HTTP_STATUS/200\ndata:${JSON.stringify(event)}\n\n`,
    )
    .join("");
}

const CREATED = { type: "response.created", response: { id: "r1" } };
const DELTA = { type: "response.output_text.delta", delta: "好" };
const DONE = { type: "response.completed", response: { id: "r1" } };

describe("parseSseStream", () => {
  it("reads `data:` without the space, skipping id / event / comment lines", async () => {
    expect(await eventsOf(chunked(bare([CREATED, DELTA, DONE])))).toEqual([
      CREATED,
      DELTA,
      DONE,
    ]);
  });

  it("still reads `data: ` with the space", async () => {
    const text = [CREATED, DONE]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("");
    expect(await eventsOf(chunked(text))).toEqual([CREATED, DONE]);
  });

  it("keeps an event whose data line and blank line arrive in two reads", async () => {
    const text = `data: ${JSON.stringify(CREATED)}\n\ndata: ${JSON.stringify(DONE)}\n\n`;
    const firstEnd = text.indexOf("\n\n") + 1;
    expect(await eventsOf(chunked(text, [firstEnd]))).toEqual([CREATED, DONE]);
  });

  it("does not lose events at any read boundary, multi-byte text included", async () => {
    const text = bare([CREATED, DELTA, DONE]);
    const length = new TextEncoder().encode(text).length;
    for (let cut = 1; cut < length; cut += 1) {
      expect(await eventsOf(chunked(text, [cut]))).toEqual([
        CREATED,
        DELTA,
        DONE,
      ]);
    }
  });

  it("takes CRLF and CR line endings, a CRLF split across two reads included", async () => {
    const crlf = bare([CREATED, DONE]).replace(/\n/g, "\r\n");
    const middle = crlf.indexOf("\r\n\r\n") + 1;
    expect(await eventsOf(chunked(crlf, [middle]))).toEqual([CREATED, DONE]);
    const cr = bare([CREATED, DONE]).replace(/\n/g, "\r");
    expect(await eventsOf(chunked(cr))).toEqual([CREATED, DONE]);
  });

  it("joins multi-line data with a newline", async () => {
    const text = 'data: {"type":"x",\ndata: "n":1}\n\n';
    expect(await eventsOf(chunked(text))).toEqual([{ type: "x", n: 1 }]);
  });

  it("skips [DONE] and malformed JSON", async () => {
    const text = `data: {oops\n\ndata: ${JSON.stringify(DONE)}\n\ndata: [DONE]\n\n`;
    expect(await eventsOf(chunked(text))).toEqual([DONE]);
  });

  it("keeps the last event when the body ends without the closing blank line", async () => {
    const text = `data: ${JSON.stringify(CREATED)}\n\ndata:${JSON.stringify(DONE)}`;
    expect(await eventsOf(chunked(text))).toEqual([CREATED, DONE]);
  });
});

describe("a turn on a stream without the space after `data:`", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs the model's tool call and finishes the turn", async () => {
    const commands: string[] = [];
    const tool: CustomTool = {
      name: "dotv",
      spec: () => ({
        type: "function",
        tool: {
          name: "dotv",
          description: "Run a command.",
          parameters: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
            additionalProperties: false,
          },
          strict: false,
        },
      }),
      execute: async (args) => {
        commands.push(String((args as { command?: unknown }).command));
        return "listed";
      },
    };

    let rounds = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      rounds += 1;
      if (rounds === 1) {
        return makeSseResponse(
          bare([
            evResponseCreated("r1"),
            {
              type: "response.output_item.done",
              item: {
                type: "function_call",
                id: "msg_1",
                call_id: "call_1",
                name: "dotv",
                arguments: '{"command": "dotv canvas-node outline"}',
              },
            },
            evCompleted("r1"),
          ]),
        );
      }
      return makeSseResponse(
        sseFlat([
          evResponseCreated("r2"),
          evAssistantMessage("done"),
          evCompleted("r2"),
        ]),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const codex = new CodexThread({
      apiKey: "test",
      model: "deepseek-flash",
      customTools: [tool],
    });
    await codex.submit({
      type: "UserInput",
      items: [{ type: "text", text: "outline the canvas" }],
    });
    await waitForEvent(codex, (m) => m.type === "TurnComplete");

    expect(commands).toEqual(["dotv canvas-node outline"]);
    expect(rounds).toBe(2);
  });
});
