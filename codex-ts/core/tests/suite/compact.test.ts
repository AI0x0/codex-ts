/**
 * mirrors codex-rs/core/tests/suite/compact.rs
 *
 * Tests for inline auto-compaction:
 *   - AutoCompactWindow token tracking (BodyAfterPrefix mode)
 *   - collectUserMessages / buildCompactedHistory helpers
 *   - Mid-turn compaction triggered when inputTokens >= autoCompactTokenLimit
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { AutoCompactWindow } from "../../src/state/auto_compact_window.js";
import {
  collectUserMessages,
  buildCompactedHistory,
  SUMMARIZATION_PROMPT,
  SUMMARY_PREFIX,
} from "../../src/compact.js";
import { CodexThread } from "../../src/codex_thread.js";
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

// ─── AutoCompactWindow unit tests ─────────────────────────────────────────────

describe("AutoCompactWindow — BodyAfterPrefix tracking", () => {
  it("starts with no baseline; bodyAfterPrefix returns 0", () => {
    const w = new AutoCompactWindow();
    // No prefill set → baseline == totalInputTokens → 0 growth
    expect(w.bodyAfterPrefix(1000)).toBe(0);
  });

  it("records server-observed prefill and measures growth", () => {
    const w = new AutoCompactWindow();
    w.ensureServerObservedPrefill(800);
    expect(w.bodyAfterPrefix(1000)).toBe(200);
  });

  it("server-observed prefill wins over estimated", () => {
    const w = new AutoCompactWindow();
    w.setEstimatedPrefill(500);
    w.ensureServerObservedPrefill(800);
    // server value (800) should win
    expect(w.bodyAfterPrefix(1000)).toBe(200);
    // Further calls to setEstimatedPrefill should be ignored
    w.setEstimatedPrefill(100);
    expect(w.bodyAfterPrefix(1000)).toBe(200);
  });

  it("startNext resets baseline and bumps ordinal", () => {
    const w = new AutoCompactWindow();
    w.ensureServerObservedPrefill(800);
    expect(w.snapshot().ordinal).toBe(1);

    w.startNext();
    const snap = w.snapshot();
    expect(snap.ordinal).toBe(2);
    expect(snap.prefillInputTokens).toBeNull();
    // After reset, no growth again
    expect(w.bodyAfterPrefix(400)).toBe(0);
  });
});

// ─── History helper unit tests ─────────────────────────────────────────────────

describe("collectUserMessages", () => {
  it("extracts text from user messages", () => {
    const history: ConversationItem[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: [{ type: "input_text", text: "follow-up" }] },
    ];
    expect(collectUserMessages(history)).toEqual(["hello", "follow-up"]);
  });

  it("skips assistant and tool messages", () => {
    const history: ConversationItem[] = [
      { role: "assistant", content: "response" },
      { type: "function_call", call_id: "c1", name: "tool", arguments: "{}" },
    ];
    expect(collectUserMessages(history)).toEqual([]);
  });
});

describe("buildCompactedHistory", () => {
  it("produces summary as the last user message", () => {
    const result = buildCompactedHistory(["msg1", "msg2"], "SUMMARY");
    const last = result[result.length - 1];
    expect("role" in (last ?? {}) && (last as { role: string }).role).toBe("user");
    expect(JSON.stringify(last)).toContain("SUMMARY");
  });

  it("uses fallback text when summary is empty", () => {
    const result = buildCompactedHistory([], "");
    const last = result[result.length - 1];
    expect(JSON.stringify(last)).toContain("(no summary available)");
  });
});

// ─── Integration: mid-turn compaction triggered ───────────────────────────────

describe("mid-turn auto-compaction", () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  function sseWithUsage(inputTokens: number, items: object[]) {
    return sseFlat([
      ...items,
      {
        type: "response.done",
        response: {
          id: "resp",
          status: "completed",
          usage: { input_tokens: inputTokens, output_tokens: 10, total_tokens: inputTokens + 10 },
        },
      },
    ]);
  }

  it("compacts mid-turn when BodyAfterPrefix growth >= autoCompactTokenLimit", async () => {
    // BodyAfterPrefix mode: round 1 sets the baseline; round 2 measures growth.
    // round 1 baseline = 1000 tokens, round 2 reports 2000 → growth = 1000 >= 900 → compact.
    const fetchMock = vi.fn();

    // Round 1 — model calls get_goal; reports 1000 tokens (sets baseline)
    fetchMock.mockResolvedValueOnce(
      makeSseResponse(
        sseWithUsage(1000, [
          evResponseCreated("resp-1"),
          evFunctionCall("call-1", "get_goal", {}),
        ]),
      ),
    );

    // Round 2 — after get_goal, model calls update_plan; usage = 2000 → growth 1000 ≥ 900
    fetchMock.mockResolvedValueOnce(
      makeSseResponse(
        sseWithUsage(2000, [
          evResponseCreated("resp-2"),
          evFunctionCall("call-2", "update_plan", { plan: [{ step: "s", status: "completed" }] }),
        ]),
      ),
    );

    // Compaction request — model returns a summary
    fetchMock.mockResolvedValueOnce(
      makeSseResponse(
        sseFlat([
          evResponseCreated("resp-compact"),
          evAssistantMessage("summary text"),
          evCompleted("resp-compact"),
        ]),
      ),
    );

    // Round 3 — after compaction, model returns final reply
    fetchMock.mockResolvedValueOnce(
      makeSseResponse(
        sseFlat([
          evResponseCreated("resp-3"),
          evAssistantMessage("done"),
          evCompleted("resp-3"),
        ]),
      ),
    );

    vi.stubGlobal("fetch", fetchMock);

    const codex = new CodexThread({
      apiKey: "test",
      model: "gpt-4o",
      autoCompactTokenLimit: 900,
    });

    await codex.submit({ type: "UserInput", items: [{ type: "text", text: "hi" }] });

    const compacted = await waitForEvent(codex, (msg) => msg.type === "ContextCompacted");
    expect(compacted.type).toBe("ContextCompacted");

    const warning = await waitForEvent(codex, (msg) => msg.type === "Warning");
    expect(warning.type).toBe("Warning");

    await waitForEvent(codex, (msg) => msg.type === "TurnComplete");

    // 4 fetches: round1, round2, compaction, round3
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // Compaction request (index 2) must include SUMMARIZATION_PROMPT as last input item
    const compactBody = JSON.parse(
      (fetchMock.mock.calls[2]![1] as RequestInit).body as string,
    ) as { input: unknown[] };
    const lastItem = compactBody.input[compactBody.input.length - 1];
    expect(JSON.stringify(lastItem)).toContain(SUMMARIZATION_PROMPT.slice(0, 30));

    // Round 3 request (index 3) must contain SUMMARY_PREFIX in history
    const finalBody = JSON.parse(
      (fetchMock.mock.calls[3]![1] as RequestInit).body as string,
    ) as { input: unknown[] };
    expect(JSON.stringify(finalBody.input)).toContain(SUMMARY_PREFIX.slice(0, 30));
  });

  it("does NOT compact when usage is below the limit", async () => {
    const fetchMock = vi.fn();

    fetchMock.mockResolvedValueOnce(
      makeSseResponse(
        sseWithUsage(500, [
          evResponseCreated("resp-1"),
          evFunctionCall("call-1", "get_goal", {}),
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

    const codex = new CodexThread({
      apiKey: "test",
      model: "gpt-4o",
      autoCompactTokenLimit: 900,
    });

    await codex.submit({ type: "UserInput", items: [{ type: "text", text: "hi" }] });
    await waitForEvent(codex, (msg) => msg.type === "TurnComplete");

    // Only two fetches: no compaction
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
