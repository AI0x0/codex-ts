/**
 * Op::InjectUserInput — steering a running turn (mirrors codex-rs inject_input).
 *
 * The case it exists for: a tool returns text, but what it produced is a picture
 * (a previz contact sheet, a screenshot). The tool output channel is a string,
 * so the host injects the picture as a user-role message. It has to land AFTER
 * that tool's function_call_output and BEFORE the next request — a user message
 * between two tool outputs would break the tool_use/tool_result pairing on
 * Chat-Completions-shaped upstreams.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { CodexThread } from "../../src/codex_thread.js";
import type { CustomTool } from "../../src/tools/router.js";
import type { ConversationItem } from "../../../thread-store/src/types.js";
import {
  evAssistantMessage,
  evCompleted,
  evFunctionCall,
  evResponseCreated,
  makeSseResponse,
  sseFlat,
  waitForEvent,
} from "../common/lib.js";

const SHEET_URL = "https://example.test/contact-sheet.jpg";

type Captured = { input: ConversationItem[] };

function describeItem(item: ConversationItem): string {
  if (item.type === "message") {
    const parts = Array.isArray(item.content)
      ? item.content.map((part) => part.type).join("+")
      : "text";
    return `${item.role}:${parts}`;
  }
  return item.type;
}

describe("Op::InjectUserInput", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("injected while a tool runs: lands after that tool's output, before the next request", async () => {
    let codexRef!: CodexThread;
    const lookTool: CustomTool = {
      name: "record_previz",
      spec: () => ({
        type: "function",
        tool: {
          name: "record_previz",
          description: "Records a previz clip and produces a contact sheet.",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          strict: false,
        },
      }),
      execute: async () => {
        // The host injects the picture the tool produced before returning its
        // text output — the drain must still order it behind the output.
        await codexRef.submit({
          type: "InjectUserInput",
          items: [
            { type: "text", text: "[stage] contact sheet of the shot just recorded" },
            { type: "image", image_url: SHEET_URL },
          ],
        });
        return "Recorded the previz clip. Contact sheet attached.";
      },
    };

    const captured: Captured[] = [];
    const fetchMock = vi.fn().mockImplementation(
      async (_url: string, init: RequestInit) => {
        captured.push(JSON.parse(init.body as string) as Captured);
        if (captured.length === 1) {
          return makeSseResponse(
            sseFlat([
              evResponseCreated("r1"),
              evFunctionCall("call-1", "record_previz", {}),
              evCompleted("r1"),
            ]),
          );
        }
        return makeSseResponse(
          sseFlat([
            evResponseCreated("r2"),
            evAssistantMessage("Looked at it: both figures stand on the floor."),
            evCompleted("r2"),
          ]),
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const codex = new CodexThread({
      apiKey: "test",
      model: "gpt-4o",
      customTools: [lookTool],
    });
    codexRef = codex;

    await codex.submit({
      type: "UserInput",
      items: [{ type: "text", text: "record shot 1" }],
    });
    await waitForEvent(codex, (m) => m.type === "TurnComplete");

    expect(captured).toHaveLength(2);
    const second = captured[1]!.input;
    const shapes = second.map(describeItem);
    const outputAt = second.findIndex(
      (item) => item.type === "function_call_output",
    );
    const injectedAt = second.findIndex(
      (item) =>
        item.type === "message" &&
        item.role === "user" &&
        Array.isArray(item.content) &&
        item.content.some(
          (part) => part.type === "input_image" && part.image_url === SHEET_URL,
        ),
    );
    expect(outputAt, shapes.join(" | ")).toBeGreaterThan(0);
    expect(injectedAt, shapes.join(" | ")).toBe(outputAt + 1);
    // Nothing but the injection sits between the tool output and the end of the input.
    expect(injectedAt).toBe(second.length - 1);
    // The first request never saw it (it did not exist yet).
    expect(
      captured[0]!.input.some((item) => describeItem(item) === "user:input_text+input_image"),
    ).toBe(false);
  });

  it("injected while idle: recorded now, carried by the next turn ahead of its own message", async () => {
    const captured: Captured[] = [];
    const fetchMock = vi.fn().mockImplementation(
      async (_url: string, init: RequestInit) => {
        captured.push(JSON.parse(init.body as string) as Captured);
        const id = `r${captured.length}`;
        return makeSseResponse(
          sseFlat([evResponseCreated(id), evAssistantMessage("ok"), evCompleted(id)]),
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const codex = new CodexThread({ apiKey: "test", model: "gpt-4o" });
    await codex.submit({
      type: "UserInput",
      items: [{ type: "text", text: "first" }],
    });
    await waitForEvent(codex, (m) => m.type === "TurnComplete");

    await codex.submit({
      type: "InjectUserInput",
      items: [{ type: "image", image_url: SHEET_URL }],
    });
    await codex.submit({
      type: "UserInput",
      items: [{ type: "text", text: "second" }],
    });
    await waitForEvent(codex, (m) => m.type === "TurnComplete");

    const shapes = captured[1]!.input.map(describeItem);
    const injectedAt = shapes.indexOf("user:input_image");
    const secondAt = captured[1]!.input.findIndex(
      (item) =>
        item.type === "message" &&
        item.role === "user" &&
        Array.isArray(item.content) &&
        item.content.some((part) => part.type === "input_text" && part.text === "second"),
    );
    expect(injectedAt, shapes.join(" | ")).toBeGreaterThan(0);
    expect(secondAt, shapes.join(" | ")).toBe(injectedAt + 1);
  });

  it("injected while the model is answering (no tool calls): the turn samples once more", async () => {
    let codexRef!: CodexThread;
    const captured: Captured[] = [];
    const fetchMock = vi.fn().mockImplementation(
      async (_url: string, init: RequestInit) => {
        captured.push(JSON.parse(init.body as string) as Captured);
        if (captured.length === 1) {
          // Arrives while the first (final-looking) sampling round is in flight —
          // mirrors codex-rs `needs_follow_up = model_needs_follow_up || has_pending_input`.
          await codexRef.submit({
            type: "InjectUserInput",
            items: [{ type: "image", image_url: SHEET_URL }],
          });
        }
        const id = `r${captured.length}`;
        return makeSseResponse(
          sseFlat([evResponseCreated(id), evAssistantMessage(`answer ${id}`), evCompleted(id)]),
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const codex = new CodexThread({ apiKey: "test", model: "gpt-4o" });
    codexRef = codex;
    await codex.submit({
      type: "UserInput",
      items: [{ type: "text", text: "go" }],
    });
    const done = await waitForEvent(codex, (m) => m.type === "TurnComplete");

    expect(captured).toHaveLength(2);
    const shapes = captured[1]!.input.map(describeItem);
    // history: user "go", assistant "answer r1" (recorded as a text message), injected
    // picture → sampled again with the picture last.
    expect(shapes.slice(-2), shapes.join(" | ")).toEqual([
      "assistant:text",
      "user:input_image",
    ]);
    expect(done.type === "TurnComplete" && done.event.last_agent_message).toBe("answer r2");
  });

  it("an empty injection records nothing", async () => {
    const captured: Captured[] = [];
    // Stub fetch BEFORE constructing: the thread captures `fetch` at construction.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        captured.push(JSON.parse(init.body as string) as Captured);
        return makeSseResponse(
          sseFlat([evResponseCreated("r1"), evAssistantMessage("ok"), evCompleted("r1")]),
        );
      }),
    );
    const codex = new CodexThread({ apiKey: "test", model: "gpt-4o" });
    await codex.submit({ type: "InjectUserInput", items: [] });
    await codex.submit({
      type: "UserInput",
      items: [{ type: "text", text: "only" }],
    });
    await waitForEvent(codex, (m) => m.type === "TurnComplete");
    expect(captured[0]!.input.filter((item) => item.type === "message" && item.role === "user")).toHaveLength(1);
  });
});
