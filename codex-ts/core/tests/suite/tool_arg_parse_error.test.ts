/**
 * mirror codex-rs: when a tool call's `arguments` can't be parsed (invalid JSON,
 * or valid JSON that isn't an object), codex-rs does NOT run the tool — it returns
 * "failed to parse function arguments" as the function_call_output so the model
 * sees the error and can retry (core/src/tools/handlers/mod.rs:77-84 parse_arguments
 * → core/src/tools/parallel.rs:186-209 failure_response; MCP twin at
 * core/src/mcp_tool_call.rs:117-132).
 *
 * Before this fix codex-ts did `catch { args = {} }` and dispatched the tool with
 * empty args — so an upstream (codeproxy) that dropped the arguments was 100%
 * invisible: the tool ran on nothing and the model never learned the args were lost.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { CodexThread } from "../../src/codex_thread.js";
import type { CustomTool } from "../../src/tools/router.js";
import type { ConversationItem } from "../../../thread-store/src/types.js";
import {
  evAssistantMessage,
  evCompleted,
  evResponseCreated,
  makeSseResponse,
  sse,
  sseFlat,
  waitForEvent,
} from "../common/lib.js";

describe("invalid tool-call arguments", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a parse error to the model and does NOT execute the tool", async () => {
    let executed = false;
    const tool: CustomTool = {
      name: "my_tool",
      spec: () => ({
        type: "function",
        tool: {
          name: "my_tool",
          description: "A tool.",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          strict: false,
        },
      }),
      execute: async () => {
        executed = true;
        return "should not run";
      },
    };

    const capturedBodies: { input: ConversationItem[] }[] = [];
    const fetchMock = vi
      .fn()
      .mockImplementation(async (_url: string, init: RequestInit) => {
        capturedBodies.push(
          JSON.parse(init.body as string) as { input: ConversationItem[] },
        );
        // Round 1: model emits a function_call whose arguments are invalid JSON.
        if (capturedBodies.length === 1) {
          return makeSseResponse(
            sse([
              evResponseCreated("r1"),
              {
                type: "response.output_item.added",
                item: {
                  type: "function_call",
                  call_id: "call-bad",
                  name: "my_tool",
                },
              },
              {
                type: "response.output_item.done",
                item: {
                  type: "function_call",
                  call_id: "call-bad",
                  name: "my_tool",
                  arguments: "{not valid json",
                },
              },
              evCompleted("r1"),
            ]),
          );
        }
        // Any later round (after the model sees the error): finish with a message.
        return makeSseResponse(
          sseFlat([
            evResponseCreated(`r${capturedBodies.length}`),
            evAssistantMessage("ok"),
            evCompleted(`r${capturedBodies.length}`),
          ]),
        );
      });
    vi.stubGlobal("fetch", fetchMock);

    const codex = new CodexThread({
      apiKey: "test",
      model: "gpt-4o",
      customTools: [tool],
    });

    await codex.submit({
      type: "UserInput",
      items: [{ type: "text", text: "call my_tool" }],
    });
    await waitForEvent(codex, (m) => m.type === "TurnComplete");

    // The tool must never run with empty args.
    expect(executed).toBe(false);

    // The follow-up request (capturedBodies[1]) must carry exactly one
    // function_call_output for call-bad, and it must be the parse error — this is
    // what lets the model diagnose/retry instead of silently getting empty args.
    const followup = capturedBodies[1]!.input;
    const outputs = followup.filter(
      (i) => i.type === "function_call_output" && i.call_id === "call-bad",
    );
    expect(outputs).toHaveLength(1);
    expect((outputs[0] as { output: string }).output).toContain(
      "failed to parse function arguments",
    );
  });
});
