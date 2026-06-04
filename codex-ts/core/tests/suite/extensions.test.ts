/**
 * Tests for the host-extension features added on top of the codex-rs mirror:
 *   - custom tool registration (CodexThreadConfig.customTools)
 *   - Op.Interrupt aborting the in-flight turn
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { CodexThread } from "../../src/codex_thread.js";
import type { CustomTool } from "../../src/tools/router.js";
import {
  evAssistantMessage,
  evCompleted,
  evFunctionCall,
  evResponseCreated,
  makeSseResponse,
  sseFlat,
  waitForEvent,
} from "../common/lib.js";

describe("custom tools", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("advertises the spec and routes calls to execute()", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      makeSseResponse(
        sseFlat([
          evResponseCreated("resp-1"),
          evFunctionCall("call-1", "echo_tool", { value: "hi" }),
          evCompleted("resp-1"),
        ]),
      ),
    );
    fetchMock.mockResolvedValueOnce(
      makeSseResponse(
        sseFlat([
          evResponseCreated("resp-2"),
          evAssistantMessage("done"),
          evCompleted("resp-2"),
        ]),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const calls: { args: unknown; callId: string }[] = [];
    const echoTool: CustomTool = {
      name: "echo_tool",
      spec: () => ({
        type: "function",
        tool: {
          name: "echo_tool",
          description: "Echo the value back.",
          parameters: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
          strict: false,
        },
      }),
      execute: async (args, ctx) => {
        calls.push({ args, callId: ctx.callId });
        return JSON.stringify({ echoed: (args as { value: string }).value });
      },
    };

    const codex = new CodexThread({
      apiKey: "test",
      model: "gpt-4o",
      customTools: [echoTool],
    });
    await codex.submit({
      type: "UserInput",
      items: [{ type: "text", text: "echo hi" }],
    });

    await waitForEvent(codex, (m) => m.type === "TurnComplete");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual({ value: "hi" });
    expect(calls[0]!.callId).toBe("call-1");

    // The custom tool spec is advertised in the first request.
    const firstInit = fetchMock.mock.calls[0]![1] as RequestInit;
    const firstBody = JSON.parse(firstInit.body as string) as {
      tools: { name: string }[];
    };
    expect(firstBody.tools.some((t) => t.name === "echo_tool")).toBe(true);

    // The tool output is appended to history before the second request.
    const secondInit = fetchMock.mock.calls[1]![1] as RequestInit;
    const secondBody = JSON.parse(secondInit.body as string) as {
      input: { type?: string; output?: string }[];
    };
    const output = secondBody.input.find(
      (item) => item.type === "function_call_output",
    );
    expect(output?.output).toContain("echoed");
  });

  it("applies per-turn instructions/model overrides", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeSseResponse(
        sseFlat([
          evResponseCreated("resp-1"),
          evAssistantMessage("ok"),
          evCompleted("resp-1"),
        ]),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const codex = new CodexThread({
      apiKey: "test",
      model: "thread-model",
      instructions: "thread-instructions",
    });
    await codex.submit({
      type: "UserInput",
      items: [{ type: "text", text: "go" }],
      instructions: "turn-instructions",
      model: "turn-model",
    });
    await waitForEvent(codex, (m) => m.type === "TurnComplete");

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      model: string;
      instructions: string;
    };
    expect(body.model).toBe("turn-model");
    expect(body.instructions).toBe("turn-instructions");
  });
});

describe("interrupt", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("aborts the in-flight turn and emits an Error", async () => {
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init: RequestInit): Promise<Response> =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init.signal;
          const onAbort = () =>
            reject(new DOMException("aborted", "AbortError"));
          if (signal?.aborted) {
            onAbort();
            return;
          }
          signal?.addEventListener("abort", onAbort);
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const codex = new CodexThread({ apiKey: "test", model: "gpt-4o" });
    await codex.submit({
      type: "UserInput",
      items: [{ type: "text", text: "hang" }],
    });
    await waitForEvent(codex, (m) => m.type === "TurnStarted");
    // Let the turn reach fetch() and register the abort listener.
    await new Promise((resolve) => setTimeout(resolve, 20));

    await codex.submit({ type: "Interrupt" });

    const err = await waitForEvent(codex, (m) => m.type === "Error");
    expect(err.type).toBe("Error");
  });
});
