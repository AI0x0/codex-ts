/**
 * Regression: a user-provided image input MUST reach the Responses API as an
 * `input_image` content part.
 *
 * codex-rs serializes such input as `ContentItem::InputImage { image_url, detail }`
 * (protocol/src/models.rs), riding the `input` message content as
 * `{"type":"input_image","image_url":...}`. codex-ts previously dropped image
 * items entirely (its content map kept only `input_text`), so the model never
 * saw the picture. These tests capture the outgoing request body and assert the
 * `input_image` part is present alongside text.
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

function userContentOf(fetchMock: ReturnType<typeof vi.fn>): WireItem[] {
  const init = fetchMock.mock.calls[0]![1] as RequestInit;
  const input = (JSON.parse(init.body as string) as { input: WireItem[] }).input;
  const userMsg = input.find((it) => it.role === "user");
  return (userMsg?.content as WireItem[] | undefined) ?? [];
}

describe("image UserInput → input_image content part", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("serializes an image item as input_image carrying its image_url", async () => {
    const fetchMock = mockSingleTurn();
    const codex = new CodexThread({ apiKey: "k", model: "m" });
    await codex.submit({
      type: "UserInput",
      items: [
        { type: "text", text: "这是什么" },
        { type: "image", image_url: "https://example.com/cat.png" },
      ],
    });
    await waitForEvent(codex, (m) => m.type === "TurnComplete");

    const content = userContentOf(fetchMock);
    expect(content).toContainEqual({ type: "input_text", text: "这是什么" });
    expect(content).toContainEqual({
      type: "input_image",
      image_url: "https://example.com/cat.png",
    });
  });

  it("keeps an image-only message (no text part)", async () => {
    const fetchMock = mockSingleTurn();
    const codex = new CodexThread({ apiKey: "k", model: "m" });
    await codex.submit({
      type: "UserInput",
      items: [{ type: "image", image_url: "https://example.com/x.png" }],
    });
    await waitForEvent(codex, (m) => m.type === "TurnComplete");

    const content = userContentOf(fetchMock);
    expect(content).toEqual([
      { type: "input_image", image_url: "https://example.com/x.png" },
    ]);
  });
});

// mirrors UserInput::Audio → ContentItem::InputAudio (protocol/src/models.rs:1778)
describe("audio UserInput → input_audio content part", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("serializes an audio item as input_audio carrying its data URI", async () => {
    const fetchMock = mockSingleTurn();
    const codex = new CodexThread({ apiKey: "k", model: "m" });
    await codex.submit({
      type: "UserInput",
      items: [
        { type: "text", text: "转写这段录音" },
        { type: "audio", audio_url: "data:audio/webm;base64,AAAA" },
      ],
    });
    await waitForEvent(codex, (m) => m.type === "TurnComplete");

    const content = userContentOf(fetchMock);
    expect(content).toEqual([
      { type: "input_text", text: "转写这段录音" },
      { type: "input_audio", audio_url: "data:audio/webm;base64,AAAA" },
    ]);
  });
});
