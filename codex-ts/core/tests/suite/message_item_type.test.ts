/**
 * Regression: Responses API `input` message items MUST carry `type: "message"`.
 *
 * codex-rs serializes `ResponseItem::Message` with
 * `#[serde(tag = "type", rename_all = "snake_case")]`, so every message rides
 * the wire as `{"type":"message","role":...,"content":...}`. codex-ts must
 * mirror that exactly. Discriminating user/assistant by `role` alone (omitting
 * `type`) is a silent divergence: strict Responses-API translators that key off
 * `type` (e.g. codeproxy's `String(item.type) || "message"`, which turns a
 * missing `type` into the literal string `"undefined"`) then DROP every message
 * item — the model receives only the system prompt and replies with nonsense.
 *
 * These tests capture the actual request body and assert the discriminator is
 * present on user, assistant (replayed as history), and context items.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { CodexThread } from "../../src/codex_thread.js";
import type { SkillMetadata } from "../../src/skills.js";
import {
  evAssistantMessage,
  evCompleted,
  evResponseCreated,
  makeSseResponse,
  sseFlat,
  waitForEvent,
} from "../common/lib.js";

const SKILLS: SkillMetadata[] = [
  {
    name: "song-analyzer",
    description: "Analyze a song.",
    path: ".agents/skills/song-analyzer/SKILL.md",
  },
];

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

function inputOf(fetchMock: ReturnType<typeof vi.fn>, callIndex = 0): WireItem[] {
  const init = fetchMock.mock.calls[callIndex]![1] as RequestInit;
  return (JSON.parse(init.body as string) as { input: WireItem[] }).input;
}

describe("Responses input items carry the `type` discriminator", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("tags the user message with type:'message'", async () => {
    const fetchMock = mockSingleTurn();
    const codex = new CodexThread({ apiKey: "k", model: "m" });
    await codex.submit({
      type: "UserInput",
      items: [{ type: "text", text: "你好" }],
    });
    await waitForEvent(codex, (m) => m.type === "TurnComplete");

    const userMsg = inputOf(fetchMock).find((it) => it.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg!.type).toBe("message");
  });

  it("tags every role-bearing item (user + context) and emits no role-only item", async () => {
    const fetchMock = mockSingleTurn();
    const codex = new CodexThread({
      apiKey: "k",
      model: "m",
      baseInstructions: "",
      agentsMd: "PROJECT_DOC",
      skills: SKILLS,
    });
    await codex.submit({
      type: "UserInput",
      items: [{ type: "text", text: "hi" }],
    });
    await waitForEvent(codex, (m) => m.type === "TurnComplete");

    const input = inputOf(fetchMock);
    // contextItems (agentsMd + catalog) + the user message all carry a role.
    const roleItems = input.filter((it) => "role" in it);
    expect(roleItems.length).toBeGreaterThan(1);
    for (const item of roleItems) {
      expect(item.type).toBe("message");
    }
    // Invariant: a role-bearing item without type:"message" is exactly the bug.
    expect(input.some((it) => "role" in it && it.type !== "message")).toBe(false);
  });

  it("tags the assistant message when it is replayed as history next turn", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeSseResponse(
          sseFlat([
            evResponseCreated("r1"),
            evAssistantMessage("hi there"),
            evCompleted("r1"),
          ]),
        ),
      )
      .mockResolvedValueOnce(
        makeSseResponse(
          sseFlat([
            evResponseCreated("r2"),
            evAssistantMessage("again"),
            evCompleted("r2"),
          ]),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const codex = new CodexThread({ apiKey: "k", model: "m" });
    await codex.submit({
      type: "UserInput",
      items: [{ type: "text", text: "first" }],
    });
    await waitForEvent(codex, (m) => m.type === "TurnComplete");
    await codex.submit({
      type: "UserInput",
      items: [{ type: "text", text: "second" }],
    });
    await waitForEvent(codex, (m) => m.type === "TurnComplete");

    // The 2nd request replays turn-1's assistant message as history.
    const assistantMsg = inputOf(fetchMock, 1).find(
      (it) => it.role === "assistant",
    );
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.type).toBe("message");
    expect(assistantMsg!.content).toBe("hi there");
  });
});
