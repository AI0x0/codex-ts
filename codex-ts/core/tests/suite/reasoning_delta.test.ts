/**
 * mirrors codex-api/src/sse/responses.rs's reasoning arms (responses.rs:355-379)
 * and ReasoningContentDeltaEvent (protocol/src/protocol.rs:1873).
 *
 * `response.reasoning_summary_text.delta` carries `summary_index`,
 * `response.reasoning_text.delta` carries `content_index`; both land on
 * ReasoningContentDelta.summary_index so a host can keep separate reasoning
 * blocks apart, and `item_id` identifies the reasoning item.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { CodexThread } from "../../src/codex_thread.js";
import type { ReasoningContentDeltaEvent } from "../../../protocol/src/protocol.js";
import {
  evAssistantMessage,
  evCompleted,
  evResponseCreated,
  makeSseResponse,
  sseFlat,
  waitForEvent,
} from "../common/lib.js";

describe("ReasoningContentDelta", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("carries item_id and the block index from both reasoning event kinds", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeSseResponse(
        sseFlat([
          evResponseCreated("r1"),
          {
            type: "response.reasoning_summary_text.delta",
            item_id: "rs-1",
            summary_index: 2,
            delta: "planning",
          },
          {
            type: "response.reasoning_text.delta",
            item_id: "rs-2",
            content_index: 5,
            delta: "thinking",
          },
          evAssistantMessage("ok"),
          evCompleted("r1"),
        ]),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const codex = new CodexThread({ apiKey: "k", model: "m" });
    await codex.submit({
      type: "UserInput",
      items: [{ type: "text", text: "hi" }],
    });

    const deltas: ReasoningContentDeltaEvent[] = [];
    await waitForEvent(codex, (msg) => {
      if (msg.type === "ReasoningContentDelta") deltas.push(msg.event);
      return msg.type === "TurnComplete";
    });

    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toEqual({
      turn_id: deltas[0]!.turn_id,
      item_id: "rs-1",
      delta: "planning",
      summary_index: 2,
    });
    expect(deltas[1]).toEqual({
      turn_id: deltas[1]!.turn_id,
      item_id: "rs-2",
      delta: "thinking",
      summary_index: 5,
    });
  });

  it("defaults summary_index to 0 when the provider omits the index", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeSseResponse(
        sseFlat([
          evResponseCreated("r1"),
          { type: "response.reasoning_text.delta", delta: "hmm" },
          evAssistantMessage("ok"),
          evCompleted("r1"),
        ]),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const codex = new CodexThread({ apiKey: "k", model: "m" });
    await codex.submit({
      type: "UserInput",
      items: [{ type: "text", text: "hi" }],
    });

    let delta: ReasoningContentDeltaEvent | null = null;
    await waitForEvent(codex, (msg) => {
      if (msg.type === "ReasoningContentDelta") delta = msg.event;
      return msg.type === "TurnComplete";
    });

    expect(delta).not.toBeNull();
    expect(delta!.summary_index).toBe(0);
    expect(delta!.item_id).not.toBe("");
  });
});
