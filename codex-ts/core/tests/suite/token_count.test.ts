/**
 * TokenCount event — mirrors EventMsg::TokenCount (protocol.rs:1211), emitted
 * after each sampled response's usage is recorded (send_token_count_event,
 * session/mod.rs:3131). Hosts consume it to display context consumption and
 * headroom to the compaction triggers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { CodexThread } from "../../src/codex_thread.js";
import {
  evAssistantMessage,
  evResponseCreated,
  makeSseResponse,
  sseFlat,
  waitForEventMatch,
} from "../common/lib.js";

describe("TokenCount event", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("emits recorded usage with the configured context window after response.completed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeSseResponse(
        sseFlat([
          evResponseCreated("r1"),
          evAssistantMessage("ok"),
          {
            type: "response.completed",
            response: {
              id: "r1",
              status: "completed",
              usage: {
                input_tokens: 900,
                input_tokens_details: {
                  cached_tokens: 120,
                  cache_write_tokens: 60,
                },
                output_tokens: 100,
                output_tokens_details: { reasoning_tokens: 40 },
                total_tokens: 1000,
              },
            },
          },
        ]),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const codex = new CodexThread({
      apiKey: "test",
      model: "gpt-4o",
      contextWindow: 900_000,
    });
    await codex.submit({
      type: "UserInput",
      items: [{ type: "text", text: "hi" }],
    });

    const tokenCount = await waitForEventMatch(codex, (msg) =>
      msg.type === "TokenCount" ? msg.event : null,
    );
    expect(tokenCount.info).not.toBeNull();
    expect(tokenCount.info?.last_token_usage).toEqual({
      input_tokens: 900,
      cached_input_tokens: 120,
      // mirrors TokenUsage::cache_write_input_tokens ←
      // usage.input_tokens_details.cache_write_tokens (responses.rs:137)
      cache_write_input_tokens: 60,
      output_tokens: 100,
      reasoning_output_tokens: 40,
      total_tokens: 1000,
    });
    // ts session accounting REPLACES the total with each response's total.
    expect(tokenCount.info?.total_token_usage.total_tokens).toBe(1000);
    expect(tokenCount.info?.model_context_window).toBe(900_000);
    expect(tokenCount.rate_limits).toBeNull();
  });

  it("defaults optional usage detail fields to 0 and window to null", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeSseResponse(
        sseFlat([
          evResponseCreated("r1"),
          evAssistantMessage("ok"),
          {
            type: "response.completed",
            response: {
              id: "r1",
              status: "completed",
              usage: { input_tokens: 50, total_tokens: 60 },
            },
          },
        ]),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const codex = new CodexThread({ apiKey: "test", model: "gpt-4o" });
    await codex.submit({
      type: "UserInput",
      items: [{ type: "text", text: "hi" }],
    });

    const tokenCount = await waitForEventMatch(codex, (msg) =>
      msg.type === "TokenCount" ? msg.event : null,
    );
    expect(tokenCount.info?.last_token_usage).toEqual({
      input_tokens: 50,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 60,
    });
    expect(tokenCount.info?.model_context_window).toBeNull();
  });
});
