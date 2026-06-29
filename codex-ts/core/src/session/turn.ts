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
import type {
  ConversationItem,
  UserContentPart,
} from "../../../thread-store/src/types.js";
import { parseSseStream } from "./sse.js";
import {
  computeRetryDelay,
  DEFAULT_MAX_RETRIES,
  isRetryableError,
  parseRetryAfter,
  ResponsesApiError,
  sleep,
} from "./retry.js";
import { runInlineAutoCompactTask } from "../compact.js";
import { AutoCompactWindow } from "../state/auto_compact_window.js";

// ConversationItem from thread-store is the canonical type for both
// history sent to the API and items persisted to the store.
type HistoryItem = ConversationItem;

// ─── TurnConfig ──────────────────────────────────────────────────────────────

export interface TurnConfig {
  apiKey: string;
  baseUrl: string;
  /** Custom fetch for the Responses API call; defaults to the global fetch. */
  fetch?: typeof fetch | undefined;
  model: string;
  /** Reasoning effort for the Responses API. codeproxy maps `reasoning.effort`
   *  to the upstream thinking budget — REQUIRED for Gemini to stream reasoning
   *  (thought) deltas (surfaced as ReasoningContentDelta). Defaults to "medium"
   *  when omitted. */
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
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
  /**
   * Max retries for transient Responses request/stream failures — network
   * errors, 5xx / 408 / 409 / 429, or a stream dropped before any visible
   * output. Each retry waits an exponential backoff (200ms × 2^(n-1) ± 10%
   * jitter), honoring a server Retry-After when present. mirrors codex-rs
   * stream/request_max_retries. Defaults to DEFAULT_MAX_RETRIES (5).
   */
  maxRetries?: number | undefined;
  /**
   * Turn-scoped context messages prepended to `input` ahead of history,
   * mirroring codex-rs's contextual user fragments: user_instructions
   * (developer + AGENTS.md) and the skills catalog ride here as discrete
   * messages rather than baked into the `instructions` field. Not persisted.
   */
  contextItems?: HistoryItem[] | undefined;
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
  /** Additional SEPARATE user messages to record alongside `userItems` in this
   *  one turn — each entry is one message's content items and becomes its own
   *  role:user history item, never merged. Mirrors codex-rs draining several
   *  queued UserInput submissions into the turn as distinct messages (so the
   *  app can flush a whole send-queue as one turn: "send all queued, not
   *  merged into one message"). */
  extraUserMessages?: UserInput[][] | undefined,
): Promise<{ lastAgentMessage: string }> {
  // Record one user message per submitted group, in order (mutates the shared
  // history array). codex-rs records each queued UserInput submission as its OWN
  // role:user item and never merges them; we mirror that by recording `userItems`
  // (the primary message) followed by each `extraUserMessages` entry as a separate
  // message. text → input_text, image → input_image { image_url } (detail default).
  const toUserContent = (items: UserInput[]): UserContentPart[] =>
    items
      .map((item): UserContentPart | null =>
        item.type === "text"
          ? { type: "input_text", text: item.text }
          : item.type === "image"
            ? { type: "input_image", image_url: item.image_url }
            : null,
      )
      .filter((part): part is UserContentPart => part !== null);
  const userMsgs: HistoryItem[] = [userItems, ...(extraUserMessages ?? [])]
    .map(toUserContent)
    .filter((content) => content.length > 0)
    .map((content) => ({ type: "message", role: "user", content }));
  history.push(...userMsgs);
  if (userMsgs.length > 0) {
    await liveThread?.appendConversationItems(userMsgs);
  }

  // ── Layer 2: turn-scoped skill full-body injection (mirrors codex-rs) ──────
  // A `$skill-name` mention in user input pulls that skill's full SKILL.md into
  // THIS turn's request input only. Like codex-rs contextual fragments, these
  // items are NOT pushed to history / persisted — resume stays clean and the
  // body isn't duplicated every turn.
  const skillInjectionItems: HistoryItem[] = [];
  const loadSkillContent = config.loadSkillContent;
  if (config.skills && config.skills.length > 0 && loadSkillContent) {
    const userText = [userItems, ...(extraUserMessages ?? [])]
      .flat()
      .map((item) => (item.type === "text" ? item.text : ""))
      .join("\n");
    const mentioned = extractSkillMentions(userText, config.skills);
    for (const skill of mentioned) {
      const contents = await loadSkillContent(skill).catch(() => null);
      if (contents !== null) {
        skillInjectionItems.push({
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: renderSkillInjection(skill, contents) },
          ],
        });
      }
    }
  }

  const tools = router.toolSpecs().map(toolSpecToRequestJson);
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
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
      // Reasoning: codeproxy maps `reasoning.effort` → upstream thinking budget so
      // Gemini streams reasoning (thought) deltas → ReasoningContentDelta. Without
      // it the model never emits thinking (only output text). Defaults to "medium".
      reasoning: { effort: config.reasoningEffort ?? "medium" },
      // codex-rs structure: turn-scoped context (user_instructions + skills
      // catalog) and any $mention skill bodies ride at the front, ahead of the
      // persisted conversation history. None of these are persisted.
      input: [
        ...(config.contextItems ?? []),
        ...skillInjectionItems,
        ...history,
      ],
      tools,
      stream: true,
    };
    if (config.instructions) body["instructions"] = config.instructions;

    // ── Sample from the model (retry transient failures) ────────────────────
    // mirrors codex-rs's stream retry loop (responses_retry.rs): a network
    // error / 5xx / 429 / dropped stream is retried with exponential backoff.
    // Unlike codex-rs (which re-streams in place into a TUI) codex-ts emits
    // deltas live, so we only retry while NO visible output has streamed yet —
    // re-streaming after that would duplicate text downstream.
    const functionCalls: { call_id: string; name: string; arguments: string }[] =
      [];
    const partialArgs = new Map<string, { name: string; args: string }>();
    let assistantText = "";
    let currentItemId = `item-${++itemIdCounter}`;
    let inputTokensThisRound = 0;
    let retryAttempt = 0;

    for (;;) {
      // A retry re-streams from scratch → reset per-attempt accumulators.
      functionCalls.length = 0;
      partialArgs.clear();
      assistantText = "";
      currentItemId = `item-${++itemIdCounter}`;
      inputTokensThisRound = 0;
      let emittedOutput = false;

      try {
        const res = await (config.fetch ?? fetch)(
          `${config.baseUrl}/responses`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: abortSignal ?? null,
          },
        );

        if (!res.ok || !res.body) {
          const text = res.body ? await res.text() : "(no body)";
          throw new ResponsesApiError(
            res.status,
            text,
            parseRetryAfter(res.headers),
          );
        }

        // ── Parse SSE stream ──────────────────────────────────────────────
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
              // Visible output has streamed — past this point a retry would
              // duplicate text, so failures below are no longer retryable.
              emittedOutput = true;
              emitEvent({
                type: "AgentMessageContentDelta",
                event: { turn_id: turnId, item_id: currentItemId, delta },
              });
              break;
            }
            case "response.reasoning_text.delta":
            case "response.reasoning_summary_text.delta": {
              // 模型正在产出 reasoning（thinking）——照搬 codex-rs
              // codex-api/src/sse/responses.rs 的 reasoning delta 分支。供 host 在模型
              // "真正 thinking"（而非仅已发请求未回）时显示 Thinking。Gemini 的 thinking
              // 经 codeproxy 翻译为 responses reasoning，正是从这两个 SSE 事件流出。
              const delta = String(raw["delta"] ?? "");
              emitEvent({
                type: "ReasoningContentDelta",
                event: { turn_id: turnId, delta },
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
              const resp = raw["response"] as
                | Record<string, unknown>
                | undefined;
              const usage = resp?.["usage"] as
                | Record<string, unknown>
                | undefined;
              if (typeof usage?.["input_tokens"] === "number") {
                inputTokensThisRound = usage["input_tokens"];
                compactWindow.ensureServerObservedPrefill(inputTokensThisRound);
              }
              break;
            }
          }
        }
        break; // stream consumed successfully → leave the retry loop
      } catch (err) {
        // An interrupt is terminal — never retry past a cancellation.
        if (abortSignal?.aborted) throw err;
        // Stop retrying once visible output streamed (would duplicate), the
        // budget is spent, or the error is not transient.
        if (
          emittedOutput ||
          retryAttempt >= maxRetries ||
          !isRetryableError(err)
        ) {
          throw err;
        }
        retryAttempt += 1;
        emitEvent({
          type: "Warning",
          event: { message: `Reconnecting... ${retryAttempt}/${maxRetries}` },
        });
        await sleep(computeRetryDelay(err, retryAttempt), abortSignal);
      }
    }

    // ── Persist assistant message ────────────────────────────────────────────
    if (assistantText) {
      lastAgentMessage = assistantText;
      const assistantItem: HistoryItem = {
        type: "message",
        role: "assistant",
        content: assistantText,
      };
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
