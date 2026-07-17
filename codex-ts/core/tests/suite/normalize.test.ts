/**
 * mirrors codex-rs/core/src/context_manager/normalize.rs tests
 *
 * History pairing invariants (enforced before every model request):
 *   - a function_call without an output gets a synthetic "aborted" output
 *   - a function_call_output without its call is dropped
 * plus the end-to-end regression for the production incident: a resumed
 * thread whose persisted history ends with an unpaired function_call must
 * sample with a repaired input (Anthropic otherwise 400s: "tool_use ids were
 * found without tool_result blocks immediately after").
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  ensureCallOutputsPresent,
  normalizeHistory,
  removeCorrespondingFor,
  removeOrphanOutputs,
} from "../../src/normalize.js";
import { CodexThread } from "../../src/codex_thread.js";
import { InMemoryIoBackend } from "../../../thread-store/src/io_backend.js";
import { LocalThreadStore } from "../../../thread-store/src/local_thread_store.js";
import type { ConversationItem } from "../../../thread-store/src/types.js";
import {
  evAssistantMessage,
  evCompleted,
  evResponseCreated,
  makeSseResponse,
  sseFlat,
  waitForEvent,
} from "../common/lib.js";

const call = (id: string): ConversationItem => ({
  type: "function_call",
  call_id: id,
  name: "tool",
  arguments: "{}",
});
const output = (id: string): ConversationItem => ({
  type: "function_call_output",
  call_id: id,
  output: "ok",
});
const user = (text: string): ConversationItem => ({
  type: "message",
  role: "user",
  content: text,
});

// ─── Unit: pairing invariants ──────────────────────────────────────────────────

describe("ensureCallOutputsPresent", () => {
  it("inserts a synthetic aborted output right after an unpaired call", () => {
    const items = [user("hi"), call("c1"), user("next")];
    ensureCallOutputsPresent(items);
    expect(items).toEqual([
      user("hi"),
      call("c1"),
      { type: "function_call_output", call_id: "c1", output: "aborted" },
      user("next"),
    ]);
  });

  it("leaves properly paired calls untouched and repairs several orphans", () => {
    const items = [call("c1"), output("c1"), call("c2"), call("c3")];
    ensureCallOutputsPresent(items);
    expect(items.map((i) => [i.type, "call_id" in i ? i.call_id : ""])).toEqual([
      ["function_call", "c1"],
      ["function_call_output", "c1"],
      ["function_call", "c2"],
      ["function_call_output", "c2"],
      ["function_call", "c3"],
      ["function_call_output", "c3"],
    ]);
  });
});

describe("removeOrphanOutputs", () => {
  it("drops outputs whose call is gone (post-compaction leftovers)", () => {
    const items = [user("summary"), output("dead-1"), output("dead-2"), call("c1"), output("c1")];
    removeOrphanOutputs(items);
    expect(items).toEqual([user("summary"), call("c1"), output("c1")]);
  });
});

describe("removeCorrespondingFor", () => {
  it("removes the output when its call was trimmed from the front", () => {
    const items = [output("c1"), user("x")];
    removeCorrespondingFor(items, call("c1"));
    expect(items).toEqual([user("x")]);
  });

  it("no-ops for message items", () => {
    const items = [user("x")];
    removeCorrespondingFor(items, user("y"));
    expect(items).toEqual([user("x")]);
  });
});

describe("normalizeHistory", () => {
  it("applies both invariants in one pass", () => {
    const items = [output("ghost"), call("c1"), user("mid")];
    normalizeHistory(items);
    expect(items).toEqual([
      call("c1"),
      { type: "function_call_output", call_id: "c1", output: "aborted" },
      user("mid"),
    ]);
  });
});

// ─── Integration: resumed corrupted thread self-repairs (the incident) ─────────

describe("sampling on a corrupted resumed thread", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("repairs unpaired calls/orphan outputs before the request", async () => {
    const ioBackend = new InMemoryIoBackend();
    const store = new LocalThreadStore(ioBackend);
    const threadId = "corrupted-thread";
    await store.createThread({
      threadId,
      model: "gpt-4o",
      createdAtMs: 0,
    });
    // Persisted history ends with an unpaired call (turn died mid-dispatch)
    // and contains an orphaned output (compaction rewrote history around it).
    await store.appendItems({
      threadId,
      items: [
        user("do work"),
        call("pending-call"),
        output("orphan-output"),
      ].map((item) => ({ kind: "ConversationItem" as const, item })),
    });

    const capturedBodies: { input: ConversationItem[] }[] = [];
    const fetchMock = vi.fn().mockImplementation(
      async (_url: string, init: RequestInit) => {
        capturedBodies.push(
          JSON.parse(init.body as string) as { input: ConversationItem[] },
        );
        return makeSseResponse(
          sseFlat([
            evResponseCreated("r1"),
            evAssistantMessage("repaired"),
            evCompleted("r1"),
          ]),
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const codex = await CodexThread.create({
      apiKey: "test",
      model: "gpt-4o",
      threadId,
      ioBackend,
    });
    await codex.submit({
      type: "UserInput",
      items: [{ type: "text", text: "continue" }],
    });
    await waitForEvent(codex, (msg) => msg.type === "TurnComplete");

    const input = capturedBodies[0]!.input;
    // The unpaired call now has a synthetic aborted output right after it…
    const callIdx = input.findIndex(
      (i) => i.type === "function_call" && i.call_id === "pending-call",
    );
    expect(callIdx).toBeGreaterThan(-1);
    expect(input[callIdx + 1]).toEqual({
      type: "function_call_output",
      call_id: "pending-call",
      output: "aborted",
    });
    // …and the orphaned output is gone.
    expect(
      input.some(
        (i) => i.type === "function_call_output" && i.call_id === "orphan-output",
      ),
    ).toBe(false);
  });
});
