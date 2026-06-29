/**
 * Regression: a UserInput op carrying `extraUserMessages` MUST record each entry
 * as its OWN `role:"user"` message — never merged into one. This mirrors codex-rs
 * draining several queued UserInput submissions into a single turn as distinct
 * messages, and backs the app's "flush the whole send-queue at once, but not
 * merged into one message" behavior.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { CodexThread } from "../../src/codex_thread.js";
import {
  evAssistantMessage,
  evCompleted,
  evResponseCreated,
  makeSseResponse,
  sseFlat,
  waitForEvent,
} from "../common/lib.js";

type WireItem = Record<string, unknown>;

function mockSingleTurn(assistantText = "ok") {
  const fetchMock = vi.fn().mockResolvedValue(
    makeSseResponse(
      sseFlat([
        evResponseCreated("r1"),
        evAssistantMessage(assistantText),
        evCompleted("r1"),
      ]),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function userMessagesOf(fetchMock: ReturnType<typeof vi.fn>): WireItem[] {
  const init = fetchMock.mock.calls[0]![1] as RequestInit;
  const input = (JSON.parse(init.body as string) as { input: WireItem[] }).input;
  return input.filter((it) => it.role === "user");
}

describe("UserInput extraUserMessages → separate user messages", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("records each extra message as its own role:user item, in order, not merged", async () => {
    const fetchMock = mockSingleTurn();
    const codex = new CodexThread({ apiKey: "k", model: "m" });
    await codex.submit({
      type: "UserInput",
      items: [{ type: "text", text: "111" }],
      extraUserMessages: [
        [{ type: "text", text: "222" }],
        [{ type: "text", text: "333" }],
      ],
    });
    await waitForEvent(codex, (m) => m.type === "TurnComplete");

    const userMsgs = userMessagesOf(fetchMock);
    expect(userMsgs.map((m) => m.content)).toEqual([
      [{ type: "input_text", text: "111" }],
      [{ type: "input_text", text: "222" }],
      [{ type: "input_text", text: "333" }],
    ]);
  });

  it("is unchanged when extraUserMessages is omitted (single message)", async () => {
    const fetchMock = mockSingleTurn();
    const codex = new CodexThread({ apiKey: "k", model: "m" });
    await codex.submit({
      type: "UserInput",
      items: [{ type: "text", text: "only" }],
    });
    await waitForEvent(codex, (m) => m.type === "TurnComplete");

    const userMsgs = userMessagesOf(fetchMock);
    expect(userMsgs.map((m) => m.content)).toEqual([
      [{ type: "input_text", text: "only" }],
    ]);
  });
});
