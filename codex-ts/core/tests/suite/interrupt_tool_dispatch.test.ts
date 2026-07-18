/**
 * Regression for the 2026-07-18 duplicate-tool_result incident
 * (openrouter-responses-errors/2026-07-18/a1cf9c62):
 *
 * A turn is interrupted while a tool call is mid-dispatch. The tool's promise
 * cannot be cancelled and resolves later — after the user has already started
 * the next turn, whose normalizeHistory pass synthesized an "aborted" output
 * for the unpaired call. Before the fix, the zombie dispatch loop then pushed
 * the REAL output into history too, so the same call_id carried TWO outputs →
 * Anthropic 400 "each tool_use must have a single result" on every subsequent
 * request (the duplicate is persisted → the thread is permanently bricked).
 *
 * The fix: after an interrupt the dispatch loop discards the in-flight tool's
 * result (and never starts the next one) — recording is the next turn's
 * normalize pass's job, which synthesizes exactly one "aborted" output.
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

describe("interrupt while a tool call is mid-dispatch", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("discards the late tool result; the next turn sees exactly one (aborted) output", async () => {
    // slow_tool blocks until the test resolves it — models a tool still
    // running when the user hits stop (e.g. view_image fetching a preview).
    let toolStarted!: () => void;
    const toolStartedPromise = new Promise<void>((resolve) => {
      toolStarted = resolve;
    });
    let finishTool!: (value: string) => void;
    const toolGate = new Promise<string>((resolve) => {
      finishTool = resolve;
    });
    const slowTool: CustomTool = {
      name: "slow_tool",
      spec: () => ({
        type: "function",
        tool: {
          name: "slow_tool",
          description: "Slow tool.",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          strict: false,
        },
      }),
      execute: async () => {
        toolStarted();
        return toolGate;
      },
    };

    const capturedBodies: { input: ConversationItem[] }[] = [];
    const fetchMock = vi.fn().mockImplementation(
      async (_url: string, init: RequestInit) => {
        capturedBodies.push(
          JSON.parse(init.body as string) as { input: ConversationItem[] },
        );
        // First request: the model calls slow_tool. Any later request (the
        // user's next turn) completes with a plain assistant message.
        if (capturedBodies.length === 1) {
          return makeSseResponse(
            sseFlat([
              evResponseCreated("r1"),
              evFunctionCall("call-slow", "slow_tool", {}),
              evCompleted("r1"),
            ]),
          );
        }
        return makeSseResponse(
          sseFlat([
            evResponseCreated(`r${capturedBodies.length}`),
            evAssistantMessage("next turn ok"),
            evCompleted(`r${capturedBodies.length}`),
          ]),
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const codex = new CodexThread({
      apiKey: "test",
      model: "gpt-4o",
      customTools: [slowTool],
    });

    await codex.submit({
      type: "UserInput",
      items: [{ type: "text", text: "run the slow tool" }],
    });
    // Wait until the dispatch loop is parked inside slow_tool.execute.
    await toolStartedPromise;

    await codex.submit({ type: "Interrupt" });

    // The tool finishes AFTER the interrupt — the zombie loop must discard
    // this result instead of recording it.
    finishTool("real result that must be discarded");
    const err = await waitForEvent(codex, (m) => m.type === "Error");
    expect(err.type).toBe("Error");

    // Next user turn: the request input must contain exactly ONE output for
    // call-slow — the synthesized "aborted" one, right after the call.
    await codex.submit({
      type: "UserInput",
      items: [{ type: "text", text: "continue" }],
    });
    await waitForEvent(codex, (m) => m.type === "TurnComplete");

    const input = capturedBodies[1]!.input;
    const outputs = input.filter(
      (i) => i.type === "function_call_output" && i.call_id === "call-slow",
    );
    expect(outputs).toHaveLength(1);
    expect((outputs[0] as { output: string }).output).toBe("aborted");
    expect(
      input.some(
        (i) =>
          i.type === "function_call_output" &&
          (i as { output?: unknown }).output ===
            "real result that must be discarded",
      ),
    ).toBe(false);
    const callIdx = input.findIndex(
      (i) => i.type === "function_call" && i.call_id === "call-slow",
    );
    expect(input[callIdx + 1]).toEqual({
      type: "function_call_output",
      call_id: "call-slow",
      output: "aborted",
    });
  });
});
