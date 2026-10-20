/**
 * mirrors codex-rs/core/tests/suite/request_user_input.rs
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodexThread } from "../../src/codex_thread.js";
import {
  createRequestUserInputTool,
  normalizeRequestUserInputArgs,
} from "../../src/tools/handlers/request_user_input_spec.js";
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

beforeEach(() => {
  vi.unstubAllGlobals();
});

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
      (msg) => (msg.type === "RequestUserInput" ? msg.event : null),
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
    expect(parsed.error).toMatch(
      /questions\[0\]\.options must be a non-empty array/,
    );
  });
});

describe("request_user_input malformed question is bounced back, not shown", () => {
  it("returns an error naming the bad paths and never emits RequestUserInput", async () => {
    const callId = "call-rui-shape";
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
                  id: "confirm_path",
                  header: "Confirm",
                  // The question text ended up in an option, and that option has no label.
                  options: [
                    { label: "Yes (Recommended)", description: "Continue." },
                    { description: "Proceed with deployment?" },
                  ],
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
          evAssistantMessage("retrying"),
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

    // Collect everything up to TurnComplete; a suspended turn would never get there.
    const seen: EventMsg[] = [];
    await waitForEvent(codex, (msg) => {
      seen.push(msg);
      return msg.type === "TurnComplete";
    });
    expect(seen.some((msg) => msg.type === "RequestUserInput")).toBe(false);

    const secondBody = capturedBodies[1] as {
      input: { type?: string; call_id?: string; output?: string }[];
    };
    const toolOutput = secondBody.input.find(
      (i) => i.type === "function_call_output" && i.call_id === callId,
    );
    expect(toolOutput).toBeDefined();
    const parsed = JSON.parse(toolOutput!.output ?? "{}") as { error: string };
    expect(parsed.error).toContain(
      "questions[0].question must be a non-empty string",
    );
    expect(parsed.error).toContain(
      "questions[0].options[1].label must be a non-empty string",
    );
    expect(parsed.error).toContain("Call request_user_input again");
  });
});

describe("normalizeRequestUserInputArgs guards a malformed questions field", () => {
  // Under strict:false the model can call request_user_input without a
  // `questions` array; normalize must return a tool error, never throw
  // "undefined is not an object (evaluating 'args.questions')".
  it("returns an error when questions is missing", () => {
    const result = normalizeRequestUserInputArgs({} as never);
    expect("error" in result).toBe(true);
  });

  it("returns an error when questions is not an array", () => {
    const result = normalizeRequestUserInputArgs({
      questions: "nope",
    } as never);
    expect("error" in result).toBe(true);
  });

  it("returns an error when questions is empty", () => {
    const result = normalizeRequestUserInputArgs({ questions: [] });
    expect("error" in result).toBe(true);
  });

  it("normalizes a valid question and sets isOther = true", () => {
    const result = normalizeRequestUserInputArgs({
      questions: [
        {
          id: "q1",
          header: "Q",
          question: "Pick?",
          options: [{ label: "A", description: "a" }],
        },
      ],
    });
    expect("questions" in result && result.questions[0]?.isOther).toBe(true);
  });

  // Upstream removed autoResolutionMs from the tool schema and event contract.
  it("omits autoResolutionMs even when an older model sends it", () => {
    const spec = createRequestUserInputTool().tool;
    expect(Object.keys(spec.parameters.properties ?? {})).not.toContain(
      "autoResolutionMs",
    );
    const result = normalizeRequestUserInputArgs({
      questions: [
        {
          id: "q1",
          header: "Q",
          question: "Pick?",
          options: [{ label: "A", description: "a" }],
        },
      ],
      autoResolutionMs: 90_000,
    } as never);
    expect("questions" in result).toBe(true);
    if ("questions" in result) {
      expect("autoResolutionMs" in result).toBe(false);
    }
  });
});

describe("normalizeRequestUserInputArgs checks each question's shape", () => {
  it("names the missing question text and the option with no label", () => {
    const result = normalizeRequestUserInputArgs({
      questions: [
        {
          id: "confirm_path",
          header: "Confirm",
          options: [
            { label: "Yes (Recommended)", description: "Continue." },
            { description: "Proceed with deployment?" },
          ],
        },
      ] as never,
    });
    expect(result).toEqual({
      error: expect.stringContaining(
        "questions[0].question must be a non-empty string; questions[0].options[1].label must be a non-empty string",
      ),
    });
  });

  it("treats blank text as missing", () => {
    const result = normalizeRequestUserInputArgs({
      questions: [
        {
          id: " ",
          question: "Pick?",
          options: [{ label: "  ", description: "a" }],
        },
      ] as never,
    });
    expect(result).toEqual({
      error: expect.stringContaining(
        "questions[0].id must be a non-empty string; questions[0].options[0].label must be a non-empty string",
      ),
    });
  });

  it("names a question or option that is not an object, without throwing", () => {
    expect(
      normalizeRequestUserInputArgs({ questions: [null] } as never),
    ).toEqual({
      error: expect.stringContaining("questions[0] must be an object"),
    });
    expect(
      normalizeRequestUserInputArgs({
        questions: [{ id: "q1", question: "Pick?", options: ["A"] }] as never,
      }),
    ).toEqual({
      error: expect.stringContaining(
        "questions[0].options[0] must be an object",
      ),
    });
  });

  it("rejects a header or description that is not a string", () => {
    const result = normalizeRequestUserInputArgs({
      questions: [
        {
          id: "q1",
          header: 3,
          question: "Pick?",
          options: [{ label: "A", description: null }],
        },
      ] as never,
    });
    expect(result).toEqual({
      error: expect.stringContaining(
        "questions[0].header must be a string; questions[0].options[0].description must be a string",
      ),
    });
  });

  it("accepts a question that leaves out header and description", () => {
    const result = normalizeRequestUserInputArgs({
      questions: [
        { id: "q1", question: "Pick?", options: [{ label: "A" }] },
      ] as never,
    });
    expect(result).toEqual({
      questions: [
        {
          id: "q1",
          question: "Pick?",
          options: [{ label: "A" }],
          isOther: true,
          isSecret: false,
        },
      ],
    });
  });

  it("names questions when it is missing", () => {
    expect(normalizeRequestUserInputArgs({} as never)).toEqual({
      error: expect.stringContaining("questions must be a non-empty array"),
    });
  });
});

// The question dies with its turn: an interrupt ends a turn that is waiting for
// an answer right away, without the host having to answer it first.
describe("request_user_input_interrupted", () => {
  it("ends with TurnAborted without an answer, and a late answer is a no-op", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        makeSseResponse(makeRequestUserInputArgs("call-rui-int")),
      );
    vi.stubGlobal("fetch", fetchMock);

    const codex = new CodexThread({ apiKey: "test", model: "gpt-4o" });
    await codex.submit({
      type: "UserInput",
      items: [{ type: "text", text: "please confirm" }],
    });
    const request = await waitForEventMatch<RequestUserInputEvent>(
      codex,
      (msg) => (msg.type === "RequestUserInput" ? msg.event : null),
    );

    await codex.submit({ type: "Interrupt" });
    await waitForEvent(codex, (m) => m.type === "TurnAborted");

    // Answering the abandoned question changes nothing and starts nothing.
    await codex.submit({
      type: "UserInputAnswer",
      id: request.turn_id,
      response: { answers: {} },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
