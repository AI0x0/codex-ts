/**
 * mirrors codex-rs/core/tests/suite/resume.rs
 *
 * Verifies that CodexThread.create() reloads persisted conversation history
 * so a resumed thread sends prior turns to the model.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodexThread } from "../../src/codex_thread.js";
import { InMemoryIoBackend } from "../../../thread-store/src/io_backend.js";
import {
  waitForEvent,
  sseFlat,
  evAssistantMessage,
  evCompleted,
  evResponseCreated,
  makeSseResponse,
} from "../common/lib.js";

beforeEach(() => { vi.unstubAllGlobals(); });

describe("CodexThread.create — resume", () => {
  it("loads persisted history so the model receives prior turns on resume", async () => {
    const ioBackend = new InMemoryIoBackend();
    const capturedBodies: { input: unknown[] }[] = [];

    const fetchMock = vi.fn().mockImplementation(
      async (_url: string, init: RequestInit) => {
        capturedBodies.push(JSON.parse(init.body as string) as { input: unknown[] });
        return makeSseResponse(
          sseFlat([
            evResponseCreated("resp-1"),
            evAssistantMessage("all good"),
            evCompleted("resp-1"),
          ]),
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    // ── First session: run one turn ───────────────────────────────────────────
    const first = new CodexThread({ apiKey: "test", model: "gpt-4o", ioBackend });
    const threadId = first.id;

    await first.submit({ type: "UserInput", items: [{ type: "text", text: "hello" }] });
    await waitForEvent(first, (msg) => msg.type === "TurnComplete");

    // ── Second session: resume with same threadId + ioBackend ─────────────────
    const resumed = await CodexThread.create({
      apiKey: "test",
      model: "gpt-4o",
      threadId,
      ioBackend,
    });

    await resumed.submit({ type: "UserInput", items: [{ type: "text", text: "follow-up" }] });
    await waitForEvent(resumed, (msg) => msg.type === "TurnComplete");

    // The second request should contain the full history:
    // user "hello" → assistant "all good" → user "follow-up"
    const secondBody = capturedBodies[1]!;
    const inputItems = secondBody.input as { role?: string; content?: unknown }[];

    const userMessages = inputItems.filter((i) => i.role === "user");
    const assistantMessages = inputItems.filter((i) => i.role === "assistant");

    expect(userMessages).toHaveLength(2);
    expect(assistantMessages).toHaveLength(1);

    // First user message contains "hello"
    const firstUser = userMessages[0]!;
    const firstContent = firstUser.content as { type: string; text: string }[];
    expect(firstContent.some((c) => c.text === "hello")).toBe(true);

    // Assistant message is the persisted reply
    expect((assistantMessages[0]!.content as string)).toBe("all good");
  });

  it("new CodexThread() without threadId starts fresh even with ioBackend", async () => {
    const ioBackend = new InMemoryIoBackend();
    const capturedBodies: { input: unknown[] }[] = [];

    vi.stubGlobal("fetch", vi.fn().mockImplementation(
      async (_url: string, init: RequestInit) => {
        capturedBodies.push(JSON.parse(init.body as string) as { input: unknown[] });
        return makeSseResponse(
          sseFlat([evResponseCreated("r"), evAssistantMessage("hi"), evCompleted("r")]),
        );
      },
    ));

    const thread = new CodexThread({ apiKey: "test", model: "gpt-4o", ioBackend });
    await thread.submit({ type: "UserInput", items: [{ type: "text", text: "start" }] });
    await waitForEvent(thread, (msg) => msg.type === "TurnComplete");

    // Only one user message — no prior history loaded
    const body = capturedBodies[0]!;
    const userItems = (body.input as { role?: string }[]).filter((i) => i.role === "user");
    expect(userItems).toHaveLength(1);
  });
});
