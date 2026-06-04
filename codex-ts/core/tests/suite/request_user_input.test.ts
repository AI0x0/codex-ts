/**
 * mirrors codex-rs/core/tests/suite/request_user_input.rs
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodexThread } from "../../src/codex_thread.js";
import type { EventMsg } from "../../../protocol/src/protocol.js";
import type { RequestUserInputEvent } from "../../../protocol/src/request_user_input.js";
import {
  waitForEvent,
  waitForEventMatch,
  sseFlat,
  evFunctionCall,
  evAssistantMessage,
  evCompleted,
  evResponseCreated,
  makeSseResponse,
} from "../common/lib.js";

beforeEach(() => { vi.unstubAllGlobals(); });

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequestUserInputArgs(callId: string) {
  return sseFlat([
    evResponseCreated("resp-1"),
    evFunctionCall(callId, "request_user_input", {
      questions: [
        {
          id: "confirm_path",
          header: "Confirm",
          question: "Proceed with deployment?",
          options: [
            { label: "Yes (Recommended)", description: "Continue." },
            { label: "No", description: "Abort." },
          ],
        },
      ],
    }),
    evCompleted("resp-1"),
  ]);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("request_user_input_round_trip_resolves_pending", () => {
  it("emits RequestUserInput then completes after UserInputAnswer", async () => {
    const callId = "call-rui-1";
    const fetchMock = vi.fn();

    fetchMock.mockResolvedValueOnce(
      makeSseResponse(makeRequestUserInputArgs(callId)),
    );
    fetchMock.mockResolvedValueOnce(
      makeSseResponse(
        sseFlat([
          evResponseCreated("resp-2"),
          evAssistantMessage("thanks"),
          evCompleted("resp-2"),
        ]),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const codex = new CodexThread({ apiKey: "test", model: "gpt-4o" });
    await codex.submit({
      type: "UserInput",
      items: [{ type: "text", text: "please confirm" }],
    });

    // Wait for the agent to request user input
    const request = await waitForEventMatch<RequestUserInputEvent>(
      codex,
      (msg) =>
        msg.type === "RequestUserInput" ? msg.event : null,
    );

    expect(request.call_id).toBe(callId);
    expect(request.questions).toHaveLength(1);
    expect(request.questions[0]?.id).toBe("confirm_path");
    // normalizeRequestUserInputArgs sets isOther = true
    expect(request.questions[0]?.isOther).toBe(true);

    // Submit the answer — keyed by turn_id (mirrors Op::UserInputAnswer { id: request.turn_id })
    await codex.submit({
      type: "UserInputAnswer",
      id: request.turn_id,
      response: {
        answers: {
          confirm_path: { answers: ["yes"] },
        },
      },
    });

    // After answering the turn should complete
    const done = await waitForEvent(
      codex,
      (msg): msg is Extract<EventMsg, { type: "TurnComplete" }> =>
        msg.type === "TurnComplete",
    );
    expect(done.type).toBe("TurnComplete");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("request_user_input output sent to model", () => {
  it("includes the user answers in the next Responses API request", async () => {
    const callId = "call-rui-2";
    const fetchMock = vi.fn();
    const capturedBodies: unknown[] = [];

    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBodies.push(JSON.parse(init.body as string));
      const idx = capturedBodies.length;
      if (idx === 1) {
        return makeSseResponse(makeRequestUserInputArgs(callId));
      }
      return makeSseResponse(
        sseFlat([
          evResponseCreated("resp-2"),
          evAssistantMessage("done"),
          evCompleted("resp-2"),
        ]),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const codex = new CodexThread({ apiKey: "test", model: "gpt-4o" });
    await codex.submit({
      type: "UserInput",
      items: [{ type: "text", text: "ask me something" }],
    });

    const request = await waitForEventMatch<RequestUserInputEvent>(
      codex,
      (msg) => (msg.type === "RequestUserInput" ? msg.event : null),
    );

    await codex.submit({
      type: "UserInputAnswer",
      id: request.turn_id,
      response: { answers: { confirm_path: { answers: ["yes"] } } },
    });

    await waitForEvent(codex, (msg) => msg.type === "TurnComplete");

    // The second request to the model should contain the function_call_output
    const secondBody = capturedBodies[1] as {
      input: { type?: string; call_id?: string; output?: string }[];
    };
    const toolOutput = secondBody.input.find(
      (i) => i.type === "function_call_output" && i.call_id === callId,
    );
    expect(toolOutput).toBeDefined();
    const parsed = JSON.parse(toolOutput!.output ?? "{}") as {
      answers: Record<string, { answers: string[] }>;
    };
    expect(parsed.answers["confirm_path"]?.answers).toEqual(["yes"]);
  });
});

describe("request_user_input missing options rejects", () => {
  it("returns error output when options are empty", async () => {
    const callId = "call-rui-bad";
    const fetchMock = vi.fn();
    const capturedBodies: unknown[] = [];

    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBodies.push(JSON.parse(init.body as string));
      const idx = capturedBodies.length;
      if (idx === 1) {
        return makeSseResponse(
          sseFlat([
            evResponseCreated("resp-1"),
            evFunctionCall(callId, "request_user_input", {
              questions: [
                {
                  id: "q1",
                  header: "Q",
                  question: "Choose?",
                  options: [], // invalid — empty options
                },
              ],
            }),
            evCompleted("resp-1"),
          ]),
        );
      }
      return makeSseResponse(
        sseFlat([
          evResponseCreated("resp-2"),
          evAssistantMessage("acknowledged"),
          evCompleted("resp-2"),
        ]),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const codex = new CodexThread({ apiKey: "test", model: "gpt-4o" });
    await codex.submit({
      type: "UserInput",
      items: [{ type: "text", text: "question" }],
    });

    await waitForEvent(codex, (msg) => msg.type === "TurnComplete");

    // Tool output for the bad call should contain an error, not suspend
    const secondBody = capturedBodies[1] as {
      input: { type?: string; call_id?: string; output?: string }[];
    };
    const toolOutput = secondBody.input.find(
      (i) => i.type === "function_call_output" && i.call_id === callId,
    );
    expect(toolOutput).toBeDefined();
    const parsed = JSON.parse(toolOutput!.output ?? "{}") as { error: string };
    expect(parsed.error).toMatch(/non-empty options/);
  });
});
