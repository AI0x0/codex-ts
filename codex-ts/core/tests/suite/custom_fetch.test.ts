import { beforeEach, describe, expect, it, vi } from "vitest";

import { CodexThread } from "../../src/codex_thread.js";
import {
  evAssistantMessage,
  evCompleted,
  evResponseCreated,
  makeSseResponse,
  sseFlat,
  waitForEvent,
} from "../common/lib.js";

function okSse() {
  return makeSseResponse(
    sseFlat([
      evResponseCreated("r1"),
      evAssistantMessage("ok"),
      evCompleted("r1"),
    ]),
  );
}

describe("config.fetch", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("routes Responses API calls through config.fetch, not the global fetch", async () => {
    const customFetch = vi.fn().mockResolvedValue(okSse());
    const globalFetch = vi.fn(() => {
      throw new Error("global fetch must not be called");
    });
    vi.stubGlobal("fetch", globalFetch);

    const codex = new CodexThread({
      apiKey: "secret-key",
      baseUrl: "https://example.test/v1",
      fetch: customFetch,
      model: "m",
    });
    await codex.submit({
      items: [{ text: "hi", type: "text" }],
      type: "UserInput",
    });
    await waitForEvent(codex, (m) => m.type === "TurnComplete");

    expect(globalFetch).not.toHaveBeenCalled();
    expect(customFetch).toHaveBeenCalledTimes(1);
    const [url, init] = customFetch.mock.calls[0]!;
    expect(url).toBe("https://example.test/v1/responses");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer secret-key",
    });
  });

  it("falls back to the global fetch when no config.fetch is given", async () => {
    const globalFetch = vi.fn().mockResolvedValue(okSse());
    vi.stubGlobal("fetch", globalFetch);

    const codex = new CodexThread({ apiKey: "k", model: "m" });
    await codex.submit({
      items: [{ text: "hi", type: "text" }],
      type: "UserInput",
    });
    await waitForEvent(codex, (m) => m.type === "TurnComplete");

    expect(globalFetch).toHaveBeenCalledTimes(1);
  });
});
