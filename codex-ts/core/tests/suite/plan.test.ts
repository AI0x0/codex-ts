/**
 * mirrors codex-rs/core/tests/suite/tool_harness.rs (plan-related tests)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodexThread } from "../../src/codex_thread.js";
import type { UpdatePlanArgs } from "../../../protocol/src/plan_tool.js";
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

describe("update_plan_tool_emits_plan_update_event", () => {
  it("emits PlanUpdate with correct steps and TurnComplete", async () => {
    const callId = "plan-tool-call";
    const planArgs = {
      explanation: "Tool harness check",
      plan: [
        { step: "Inspect workspace", status: "in_progress" },
        { step: "Report results", status: "pending" },
      ],
    };

    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      makeSseResponse(
        sseFlat([
          evResponseCreated("resp-1"),
          evFunctionCall(callId, "update_plan", planArgs),
          evCompleted("resp-1"),
        ]),
      ),
    );
    fetchMock.mockResolvedValueOnce(
      makeSseResponse(
        sseFlat([
          evResponseCreated("resp-2"),
          evAssistantMessage("plan acknowledged"),
          evCompleted("resp-2"),
        ]),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const codex = new CodexThread({ apiKey: "test", model: "gpt-4o" });
    await codex.submit({
      type: "UserInput",
      items: [{ type: "text", text: "please update the plan" }],
    });

    const update = await waitForEventMatch<UpdatePlanArgs>(
      codex,
      (msg) => msg.type === "PlanUpdate" ? msg.event : null,
    );

    expect(update.explanation).toBe("Tool harness check");
    expect(update.plan).toHaveLength(2);
    expect(update.plan[0]?.step).toBe("Inspect workspace");
    expect(update.plan[0]?.status).toBe("in_progress");
    expect(update.plan[1]?.step).toBe("Report results");
    expect(update.plan[1]?.status).toBe("pending");

    await waitForEvent(codex, (msg) => msg.type === "TurnComplete");

    // The tool output sent to the model should be "Plan updated"
    const secondBody = JSON.parse(
      (fetchMock.mock.calls[1]![1] as RequestInit).body as string,
    ) as { input: { type?: string; call_id?: string; output?: string }[] };

    const toolOutput = secondBody.input.find(
      (i) => i.type === "function_call_output" && i.call_id === callId,
    );
    expect(toolOutput?.output).toBe("Plan updated");
  });
});

describe("update_plan_tool_rejects_malformed_payload", () => {
  it("returns error output and does not emit PlanUpdate for missing plan", async () => {
    const callId = "plan-tool-invalid";
    const capturedBodies: { input: { type?: string; call_id?: string; output?: string }[] }[] = [];

    const fetchMock = vi.fn().mockImplementation(
      async (_url: string, init: RequestInit) => {
        capturedBodies.push(
          JSON.parse(init.body as string) as typeof capturedBodies[number],
        );
        const idx = capturedBodies.length;
        if (idx === 1) {
          return makeSseResponse(
            sseFlat([
              evResponseCreated("resp-1"),
              evFunctionCall(callId, "update_plan", { explanation: "Missing plan data" }),
              evCompleted("resp-1"),
            ]),
          );
        }
        return makeSseResponse(
          sseFlat([
            evResponseCreated("resp-2"),
            evAssistantMessage("malformed plan payload"),
            evCompleted("resp-2"),
          ]),
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const codex = new CodexThread({ apiKey: "test", model: "gpt-4o" });
    await codex.submit({
      type: "UserInput",
      items: [{ type: "text", text: "please update the plan" }],
    });

    let sawPlanUpdate = false;
    await waitForEvent(codex, (msg) => {
      if (msg.type === "PlanUpdate") sawPlanUpdate = true;
      return msg.type === "TurnComplete";
    });

    expect(sawPlanUpdate).toBe(false);

    const secondBody = capturedBodies[1]!;
    const toolOutput = secondBody.input.find(
      (i) => i.type === "function_call_output" && i.call_id === callId,
    );
    expect(toolOutput).toBeDefined();
    const parsed = JSON.parse(toolOutput!.output ?? "{}") as { error: string };
    expect(parsed.error).toMatch(/failed to parse function arguments/);
  });
});
