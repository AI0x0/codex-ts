/**
 * mirrors codex-rs/core/src/session/turn.rs
 *
 * runTurn() — the core agent sampling loop:
 *   1. Build Responses API request (history + tool specs)
 *   2. Stream SSE response
 *   3. Collect assistant text and function calls
 *   4. Dispatch tool calls via ToolRouter
 *   5. Emit side-effect events
 *   6. Loop until the model produces no more tool calls
 */

import type { EventMsg } from "../../../protocol/src/protocol.js";
import type { UserInput } from "../../../protocol/src/user_input.js";
import { toolSpecToRequestJson } from "../../../tools/src/tool_spec.js";
import { ToolRouter } from "../tools/router.js";
import { extractSkillMentions, renderSkillInjection } from "../skills.js";
import type { SkillMetadata } from "../skills.js";
import type { PendingInputs } from "../tools/handlers/request_user_input.js";
import type { LiveThread } from "../../../thread-store/src/live_thread.js";
import type { ConversationItem } from "../../../thread-store/src/types.js";
import { parseSseStream } from "./sse.js";
import { runInlineAutoCompactTask } from "../compact.js";
import { AutoCompactWindow } from "../state/auto_compact_window.js";

// ConversationItem from thread-store is the canonical type for both
// history sent to the API and items persisted to the store.
type HistoryItem = ConversationItem;

// ─── TurnConfig ──────────────────────────────────────────────────────────────

export interface TurnConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  instructions?: string | undefined;
  /** Discovered skills, for `$skill-name` full-body injection (Layer 2). */
  skills?: SkillMetadata[] | undefined;
  /**
   * Reads a skill's full SKILL.md on demand. Host-provided because a browser
   * has no filesystem (mirrors how IoBackend is injected).
   */
  loadSkillContent?: ((skill: SkillMetadata) => Promise<string>) | undefined;
  /**
   * Input-token threshold that triggers inline auto-compaction.
   * mirrors model_auto_compact_token_limit in codex-rs TurnContext config.
   *
   * In BodyAfterPrefix mode (the default) this is compared against tokens
   * added since the last compaction, not total context size.
   * Typical value: context_window × 0.9.
   * Omit to disable auto-compaction.
   */
  autoCompactTokenLimit?: number | undefined;
}

// ─── runTurn ─────────────────────────────────────────────────────────────────

export interface TurnResult {
  lastAgentMessage: string;
  /** All events emitted during the turn (including streaming deltas) */
  events: EventMsg[];
}

export async function runTurn(
  turnId: string,
  userItems: UserInput[],
  history: HistoryItem[],
  config: TurnConfig,
  router: ToolRouter,
  pendingInputs: PendingInputs,
  emitEvent: (msg: EventMsg) => void,
  liveThread?: LiveThread | undefined,
  /** mirrors: codex-rs propagates a tokio CancellationToken into the turn loop;
   *  AbortSignal is the browser-native equivalent. */
  abortSignal?: AbortSignal | undefined,
): Promise<{ lastAgentMessage: string }> {
  // Add user message to history (mutates the shared array)
  const userContent = userItems
    .map((item) =>
      item.type === "text"
        ? { type: "input_text" as const, text: item.text }
        : null,
    )
    .filter((x): x is { type: "input_text"; text: string } => x !== null);
  const userMsg: HistoryItem = { role: "user", content: userContent };
  history.push(userMsg);
  await liveThread?.appendConversationItems([userMsg]);

  // ── Layer 2: turn-scoped skill full-body injection (mirrors codex-rs) ──────
  // A `$skill-name` mention in user input pulls that skill's full SKILL.md into
  // THIS turn's request input only. Like codex-rs contextual fragments, these
  // items are NOT pushed to history / persisted — resume stays clean and the
  // body isn't duplicated every turn.
  const skillInjectionItems: HistoryItem[] = [];
  const loadSkillContent = config.loadSkillContent;
  if (config.skills && config.skills.length > 0 && loadSkillContent) {
    const userText = userItems
      .map((item) => (item.type === "text" ? item.text : ""))
      .join("\n");
    const mentioned = extractSkillMentions(userText, config.skills);
    for (const skill of mentioned) {
      const contents = await loadSkillContent(skill).catch(() => null);
      if (contents !== null) {
        skillInjectionItems.push({
          role: "user",
          content: [
            { type: "input_text", text: renderSkillInjection(skill, contents) },
          ],
        });
      }
    }
  }

  const tools = router.toolSpecs().map(toolSpecToRequestJson);
  let lastAgentMessage = "";
  let itemIdCounter = 0;

  // ── Auto-compaction window tracker (mirrors AutoCompactWindow in codex-rs) ──
  // Uses BodyAfterPrefix mode: only tokens added after the last compaction count
  // toward the limit. mirrors AutoCompactTokenLimitScope::BodyAfterPrefix.
  const compactWindow = new AutoCompactWindow();

  for (;;) {
    // Bail out before sampling again if the turn was interrupted.
    if (abortSignal?.aborted) {
      throw new DOMException("Turn interrupted", "AbortError");
    }

    // ── Sample from the model ───────────────────────────────────────────────
    const body: Record<string, unknown> = {
      model: config.model,
      // Skill bodies ride at the front as turn-scoped context, ahead of the
      // persisted conversation history.
      input: skillInjectionItems.length
        ? [...skillInjectionItems, ...history]
        : history,
      tools,
      stream: true,
    };
    if (config.instructions) body["instructions"] = config.instructions;

    const res = await fetch(`${config.baseUrl}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: abortSignal ?? null,
    });

    if (!res.ok || !res.body) {
      const text = res.body ? await res.text() : "(no body)";
      throw new Error(`Responses API ${res.status}: ${text}`);
    }

    // ── Parse SSE stream ────────────────────────────────────────────────────
    const functionCalls: { call_id: string; name: string; arguments: string }[] =
      [];
    const partialArgs = new Map<string, { name: string; args: string }>();
    let assistantText = "";
    let currentItemId = `item-${++itemIdCounter}`;
    let inputTokensThisRound = 0;

    for await (const raw of parseSseStream(res.body)) {
      switch (raw["type"]) {
        case "response.output_item.added": {
          const item = raw["item"] as Record<string, unknown> | undefined;
          if (item?.["type"] === "function_call") {
            const cid = String(item["call_id"]);
            partialArgs.set(cid, { name: String(item["name"]), args: "" });
          } else if (item?.["type"] === "message") {
            currentItemId = String(item["id"] ?? currentItemId);
          }
          break;
        }
        case "response.output_text.delta": {
          const delta = String(raw["delta"] ?? "");
          assistantText += delta;
          emitEvent({
            type: "AgentMessageContentDelta",
            event: { turn_id: turnId, item_id: currentItemId, delta },
          });
          break;
        }
        case "response.function_call_arguments.delta": {
          const partial = partialArgs.get(String(raw["call_id"] ?? ""));
          if (partial) partial.args += String(raw["delta"] ?? "");
          break;
        }
        case "response.output_item.done": {
          const item = raw["item"] as Record<string, unknown> | undefined;
          if (item?.["type"] === "function_call") {
            functionCalls.push({
              call_id: String(item["call_id"]),
              name: String(item["name"]),
              arguments: String(item["arguments"] ?? "{}"),
            });
          }
          break;
        }
        case "response.done": {
          // mirrors ensure_server_observed_prefill_from_usage in auto_compact_window.rs
          const resp = raw["response"] as Record<string, unknown> | undefined;
          const usage = resp?.["usage"] as Record<string, unknown> | undefined;
          if (typeof usage?.["input_tokens"] === "number") {
            inputTokensThisRound = usage["input_tokens"];
            compactWindow.ensureServerObservedPrefill(inputTokensThisRound);
          }
          break;
        }
      }
    }

    // ── Persist assistant message ────────────────────────────────────────────
    if (assistantText) {
      lastAgentMessage = assistantText;
      const assistantItem: HistoryItem = { role: "assistant", content: assistantText };
      history.push(assistantItem);
      await liveThread?.appendConversationItems([assistantItem]);
      emitEvent({ type: "AgentMessage", event: { message: assistantText } });
    }

    // ── Persist function calls ───────────────────────────────────────────────
    const callItems: HistoryItem[] = functionCalls.map((call) => ({
      type: "function_call" as const,
      call_id: call.call_id,
      name: call.name,
      arguments: call.arguments,
    }));
    for (const item of callItems) {
      history.push(item);
    }
    if (callItems.length > 0) await liveThread?.appendConversationItems(callItems);

    // ── Done when no tool calls ─────────────────────────────────────────────
    if (functionCalls.length === 0) break;

    // ── Auto-compaction check (mirrors post-sampling compact in turn.rs) ─────
    // Only triggered mid-turn (when there are more tool calls to dispatch),
    // matching InitialContextInjection::BeforeLastUserMessage behaviour.
    if (config.autoCompactTokenLimit !== undefined && inputTokensThisRound > 0) {
      const scopeTokens = compactWindow.bodyAfterPrefix(inputTokensThisRound);
      const limitReached = scopeTokens >= config.autoCompactTokenLimit;
      if (limitReached) {
        emitEvent({ type: "ContextCompacted", event: {} });
        await runInlineAutoCompactTask(history, config);
        compactWindow.startNext();
        emitEvent({
          type: "Warning",
          event: {
            message:
              "Heads up: Long threads and multiple compactions can cause the model to be less accurate. " +
              "Start a new thread when possible to keep threads small and targeted.",
          },
        });
      }
    }

    // ── Dispatch tool calls ─────────────────────────────────────────────────
    for (const call of functionCalls) {
      let args: unknown;
      try {
        args = JSON.parse(call.arguments);
      } catch {
        args = {};
      }

      const output = await router.dispatch(call.name, call.call_id, args, {
        turnId,
        pendingInputs,
        emitEvent,
      });

      const outputItem: HistoryItem = {
        type: "function_call_output",
        call_id: call.call_id,
        output,
      };
      history.push(outputItem);
      await liveThread?.appendConversationItems([outputItem]);
    }
  }

  return { lastAgentMessage };
}
