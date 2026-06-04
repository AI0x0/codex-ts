/**
 * mirrors codex-rs/core/tests/suite/tool_harness.rs (goal-related tests)
 * and ext/goal/src/ unit tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodexThread } from "../../src/codex_thread.js";
import { GoalToolExecutor } from "../../../ext/goal/src/tool.js";
import type { EventMsg } from "../../../protocol/src/protocol.js";
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

// ─── GoalToolExecutor unit tests ──────────────────────────────────────────────

describe("GoalToolExecutor", () => {
  let ex: GoalToolExecutor;
  beforeEach(() => { ex = new GoalToolExecutor("thread-1"); });

  it("get returns null goal when none exists", async () => {
    const r = JSON.parse((await ex.get()).output) as { goal: null };
    expect(r.goal).toBeNull();
  });

  it("create sets goal to Active", async () => {
    const r = JSON.parse((await ex.create("build it")).output) as {
      goal: { objective: string; status: string };
    };
    expect(r.goal.status).toBe("Active");
    expect(r.goal.objective).toBe("build it");
  });

  it("create rejects second goal", async () => {
    await ex.create("first");
    const r = JSON.parse((await ex.create("second")).output) as { error: string };
    expect(r.error).toMatch(/already exists/);
  });

  it("create stores token_budget", async () => {
    const r = JSON.parse((await ex.create("work", 500)).output) as {
      remaining_tokens: number;
    };
    expect(r.remaining_tokens).toBe(500);
  });

  it("update marks goal Complete", async () => {
    await ex.create("finish");
    const r = JSON.parse((await ex.update("complete")).output) as {
      goal: { status: string };
    };
    expect(r.goal.status).toBe("Complete");
  });

  it("update marks goal Blocked", async () => {
    await ex.create("finish");
    const r = JSON.parse((await ex.update("blocked")).output) as {
      goal: { status: string };
    };
    expect(r.goal.status).toBe("Blocked");
  });

  it("update fails with no goal", async () => {
    const r = JSON.parse((await ex.update("complete")).output) as { error: string };
    expect(r.error).toMatch(/No active goal/);
  });

  it("recordTokens reduces remaining budget", async () => {
    await ex.create("work", 1000);
    await ex.recordTokens(300);
    await ex.recordTokens(200);
    const r = JSON.parse((await ex.get()).output) as {
      goal: { tokens_used: number };
      remaining_tokens: number;
    };
    expect(r.goal.tokens_used).toBe(500);
    expect(r.remaining_tokens).toBe(500);
  });

  it("create emits a ThreadGoalUpdatedEvent", async () => {
    const { event } = await ex.create("do something");
    expect(event).not.toBeNull();
    expect(event?.goal.status).toBe("Active");
  });
});

// ─── Integration: create_goal tool call through CodexThread ───────────────────

describe("create_goal tool call", () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it("emits ThreadGoalUpdated event and TurnComplete", async () => {
    const fetchMock = vi.fn();

    // Turn 1: model calls create_goal
    fetchMock.mockResolvedValueOnce(
      makeSseResponse(
        sseFlat([
          evResponseCreated("resp-1"),
          evFunctionCall("call-1", "create_goal", { objective: "test goal" }),
          evCompleted("resp-1"),
        ]),
      ),
    );
    // Turn 2: model replies after receiving tool output
    fetchMock.mockResolvedValueOnce(
      makeSseResponse(
        sseFlat([
          evResponseCreated("resp-2"),
          evAssistantMessage("Goal created."),
          evCompleted("resp-2"),
        ]),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const codex = new CodexThread({ apiKey: "test", model: "gpt-4o" });
    await codex.submit({ type: "UserInput", items: [{ type: "text", text: "create a goal" }] });

    const goalUpdated = await waitForEventMatch(codex, (msg) =>
      msg.type === "ThreadGoalUpdated" ? msg.event : null,
    );
    expect(goalUpdated.goal.objective).toBe("test goal");
    expect(goalUpdated.goal.status).toBe("Active");

    const done = await waitForEvent(
      codex,
      (msg): msg is Extract<EventMsg, { type: "TurnComplete" }> => msg.type === "TurnComplete",
    );
    expect(done.type).toBe("TurnComplete");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
