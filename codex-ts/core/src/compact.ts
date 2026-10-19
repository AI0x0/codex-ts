/**
 * mirrors codex-rs/core/src/compact.rs
 *        codex-rs/prompts/templates/compact/prompt.md
 *        codex-rs/prompts/templates/compact/summary_prefix.md
 *
 * Inline context compaction: summarise the conversation with a fresh model
 * request and replace history with the summary + recent user messages.
 */

import type { ConversationItem } from "../../thread-store/src/types.js";
import type { TurnConfig } from "./session/turn.js";
import { parseSseStream } from "./session/sse.js";
import {
  classifyHttpFailure,
  classifyStreamFailure,
  DEFAULT_MAX_RETRIES,
  isContextWindowExceededError,
  ResponsesApiError,
  retryDelayFor,
  sleep,
} from "./session/retry.js";
import { normalizeHistory, removeCorrespondingFor } from "./normalize.js";
import {
  approxTokenCount,
  estimateItemsTokenCount,
} from "./state/token_state.js";

// ─── Prompt constants (verbatim from codex-rs templates) ──────────────────────

/** mirrors prompts/templates/compact/prompt.md */
export const SUMMARIZATION_PROMPT =
  "You are performing a CONTEXT CHECKPOINT COMPACTION. " +
  "Create a handoff summary for another LLM that will resume the task.\n\n" +
  "Include:\n" +
  "- Current progress and key decisions made\n" +
  "- Important context, constraints, or user preferences\n" +
  "- What remains to be done (clear next steps)\n" +
  "- Any critical data, examples, or references needed to continue\n\n" +
  "Be concise, structured, and focused on helping the next LLM seamlessly continue the work.";

/** mirrors prompts/templates/compact/summary_prefix.md */
export const SUMMARY_PREFIX =
  "Another language model started to solve this problem and produced a summary " +
  "of its thinking process. You also have access to the state of the tools that " +
  "were used by that language model. Use this to build on the work that has already " +
  "been done and avoid duplicating work. Here is the summary produced by the other " +
  "language model, use the information in this summary to assist with your own analysis:";

/** mirrors COMPACT_USER_MESSAGE_MAX_TOKENS in compact.rs */
const COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000;

// ─── Token approximation (mirrors codex-rs/utils/string/src/truncate.rs) ──────
// codex-rs budgets in UTF-8 bytes (4 per token); codex-ts's estimate counts
// UTF-16 units (see state/token_state approxTokenCount), so the same algorithm
// runs on string length here.

const APPROX_CHARS_PER_TOKEN = 4;

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Middle truncation of one message's text parts to `maxTokens`.
 *
 * mirrors truncate_annotated_text (context-fragments/src/annotated_content.rs)
 * over plan_token_truncation (utils/string/src/truncate.rs): the combined text
 * keeps its head and tail halves, the middle is cut, and a
 * "…N tokens truncated…" marker sits where the cut is — part boundaries
 * survive (a part straddling the cut keeps its head / tail slice). A cut never
 * splits a surrogate pair (rs: floor/ceil_char_boundary).
 */
function truncateTextParts(parts: string[], maxTokens: number): string[] {
  const total = parts.join("");
  const maxChars = maxTokens * APPROX_CHARS_PER_TOKEN;
  if (total.length <= maxChars) {
    return parts;
  }
  const leftBudget = Math.floor(maxChars / 2);
  const rightBudget = maxChars - leftBudget;
  let removedStart = leftBudget;
  let removedEnd = total.length - rightBudget;
  if (removedStart > 0 && isLowSurrogate(total.charCodeAt(removedStart))) {
    removedStart -= 1;
  }
  if (removedEnd < total.length && isLowSurrogate(total.charCodeAt(removedEnd))) {
    removedEnd += 1;
  }
  const removedTokens = Math.ceil(
    (total.length - maxChars) / APPROX_CHARS_PER_TOKEN,
  );
  let notice: string | undefined = `…${removedTokens} tokens truncated…`;
  const result: string[] = [];
  let offset = 0;
  for (const text of parts) {
    const start = offset;
    offset += text.length;
    if (offset <= removedStart || start >= removedEnd) {
      result.push(text);
      continue;
    }
    const prefixEnd = Math.max(0, removedStart - start);
    const suffixStart = Math.min(text.length, Math.max(0, removedEnd - start));
    if (prefixEnd > 0) {
      result.push(text.slice(0, prefixEnd));
    }
    if (notice !== undefined) {
      result.push(notice);
      notice = undefined;
    }
    if (suffixStart < text.length) {
      result.push(text.slice(suffixStart));
    }
  }
  return result;
}

// ─── History helpers ─────────────────────────────────────────────────────────

type UserMessageItem = Extract<ConversationItem, { role: "user" }>;

/**
 * One user message collected for the replacement history.
 * mirrors CompactedUserMessage (compact.rs): the flattened text only drives the
 * token budget and the truncation fallback; a whole text-only message that
 * fits is kept exactly as it was (codex-rs #48115).
 */
export interface CompactedUserMessage {
  /** The message's text parts joined by "\n". */
  message: string;
  /** The message as it sits in history. */
  original: UserMessageItem;
}

/**
 * True when a user message is itself a previous compaction summary.
 * mirrors is_summary_message (compact.rs).
 */
export function isSummaryMessage(message: string): boolean {
  return message.startsWith(`${SUMMARY_PREFIX}\n`);
}

function textPartsOf(item: UserMessageItem): string[] {
  if (typeof item.content === "string") {
    return [item.content];
  }
  return item.content
    .filter(
      (part): part is { type: "input_text"; text: string } =>
        part.type === "input_text",
    )
    .map((part) => part.text);
}

/**
 * The user messages in history, skipping previous compaction summaries.
 * mirrors collect_user_messages (compact.rs): a message that starts with
 * SUMMARY_PREFIX is dropped, so a second compaction does not re-collect the
 * first summary as a "user message" and stack summaries on top of each other.
 * Note the summary produced by THIS compaction is appended separately by
 * buildCompactedHistory.
 *
 * Browser-specific adaptation: a media-only message (no text at all) is left
 * out. codex-rs keeps it as an empty text part, but an empty text block is
 * rejected outright by some providers behind a Responses proxy (Anthropic).
 */
export function collectUserMessages(
  history: ConversationItem[],
): CompactedUserMessage[] {
  const messages: CompactedUserMessage[] = [];
  for (const item of history) {
    if (item.type !== "message" || item.role !== "user") continue;
    const message = textPartsOf(item).join("\n");
    if (message && !isSummaryMessage(message)) {
      messages.push({ message, original: item });
    }
  }
  return messages;
}

/**
 * Build the replacement history from recent user messages + summary.
 * mirrors build_compacted_history_with_limit (compact.rs):
 *   - walk user messages newest first, filling up to
 *     COMPACT_USER_MESSAGE_MAX_TOKENS;
 *   - a text-only message that fits is kept verbatim — its content parts and
 *     boundaries survive (#48115); otherwise it is rebuilt from its text parts
 *     only (images / audio are not carried over), middle-truncated to what is
 *     left of the budget, and the walk stops there;
 *   - the summary goes last, as a user message.
 */
export function buildCompactedHistory(
  userMessages: CompactedUserMessage[],
  summaryText: string,
): ConversationItem[] {
  let remaining = COMPACT_USER_MESSAGE_MAX_TOKENS;
  const selected: ConversationItem[] = [];
  for (let i = userMessages.length - 1; i >= 0 && remaining > 0; i -= 1) {
    const { message, original } = userMessages[i]!;
    const tokens = approxTokenCount(message);
    const textOnly =
      typeof original.content === "string" ||
      original.content.every((part) => part.type === "input_text");
    if (tokens <= remaining && textOnly) {
      selected.push(original);
    } else {
      const parts = truncateTextParts(textPartsOf(original), remaining)
        // An empty text block is rejected by some providers (see
        // collectUserMessages); the marker and the slices are never empty.
        .filter((text) => text.length > 0)
        .map((text) => ({ type: "input_text" as const, text }));
      selected.push({ type: "message", role: "user", content: parts });
    }
    if (tokens > remaining) {
      break;
    }
    remaining -= tokens;
  }
  selected.reverse();

  const finalSummary = summaryText || "(no summary available)";
  selected.push({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: finalSummary }],
  });
  return selected;
}

// ─── Compaction request ───────────────────────────────────────────────────────

/**
 * Run an inline compaction turn:
 *   1. Send SUMMARIZATION_PROMPT + current history to the model
 *   2. Collect the assistant's summary text — only once the response COMPLETES
 *   3. Build replacement history and mutate `history` in-place
 *
 * mirrors run_inline_auto_compact_task + run_compact_task_inner_impl in compact.rs
 * Returns the raw summary text (without SUMMARY_PREFIX).
 *
 * `signal` is the turn's interrupt hook: an interrupt aborts the summarizer
 * request and any backoff, leaving history untouched.
 */
export async function runInlineAutoCompactTask(
  history: ConversationItem[],
  config: TurnConfig,
  signal?: AbortSignal | undefined,
): Promise<string> {
  // Working copy sent to the summarizer. When the compaction request ITSELF
  // exceeds the context window, drop the OLDEST item and retry (mirrors
  // compact.rs:232-241 history.remove_first_item(): trims from the front to
  // keep the prefix cache and the recent messages intact). The replacement
  // history below is still built from the ORIGINAL `history` (mirrors rs,
  // which collects user messages from the untrimmed session history).
  // Same pairing invariants as a sampling request (mirrors for_prompt →
  // normalize_history) — Anthropic 400s on unpaired tool_use/tool_result.
  const summarizerInput: ConversationItem[] = [...history];
  normalizeHistory(summarizerInput);
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  let retries = 0;
  let trimRounds = 0;
  let summaryText = "";

  // mirrors run_inline_auto_compact_task (compact.rs:118): the host may override
  // the summarization prompt (`config.compact_prompt`), else the bundled one.
  const compactPrompt = config.compactPrompt ?? SUMMARIZATION_PROMPT;

  for (;;) {
    // Build the compaction request: history + the summarization prompt at the end
    const compactInput: ConversationItem[] = [
      ...summarizerInput,
      { type: "message", role: "user", content: compactPrompt },
    ];

    const body: Record<string, unknown> = {
      model: config.model,
      input: compactInput,
      stream: true,
    };
    if (config.instructions) body["instructions"] = config.instructions;

    try {
      const res = await (config.fetch ?? fetch)(`${config.baseUrl}/responses`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: signal ?? null,
      });

      if (!res.ok || !res.body) {
        const text = res.body ? await res.text() : "(no body)";
        throw classifyHttpFailure(res.status, text, res.headers);
      }

      // Buffer the summary until `response.completed` (mirrors
      // drain_to_completed, compact.rs; codex-rs #53932): a stream that drops,
      // fails or comes back incomplete must leave NO partial summary behind —
      // history is only replaced from a completed response.
      let streamed = "";
      let completed = false;
      for await (const raw of parseSseStream(res.body)) {
        switch (raw["type"]) {
          case "response.output_text.delta":
            streamed += String(raw["delta"] ?? "");
            break;
          case "response.completed":
            completed = true;
            break;
          case "response.failed":
          case "response.incomplete":
            // Same classification as the turn loop (context-window-exceeded →
            // trim; quota / policy / incomplete → terminal; otherwise
            // retryable). mirrors process_responses_event.
            throw classifyStreamFailure(raw);
          case "error": {
            const error = raw["error"] as Record<string, unknown> | undefined;
            if (error?.["code"] === "flex_unavailable") {
              throw classifyStreamFailure(raw);
            }
            break;
          }
        }
        if (completed) break;
      }
      if (!completed) {
        // mirrors the "stream closed before response.completed" stream error
        // (codex-api/src/sse/responses.rs) — retryable.
        throw new ResponsesApiError(
          503,
          "stream closed before response.completed",
          undefined,
          false,
          { kind: "stream" },
        );
      }
      summaryText = streamed;
      break; // summary collected → leave the retry loop
    } catch (err) {
      // An interrupt is terminal — never retry past a cancellation.
      if (signal?.aborted) throw err;
      if (isContextWindowExceededError(err)) {
        if (summarizerInput.length > 1) {
          // mirrors compact.rs:233-240 + history.remove_first_item: drop the
          // oldest item AND its call/output counterpart (pairing stays intact),
          // then try again.
          const removed = summarizerInput.shift();
          if (removed) removeCorrespondingFor(summarizerInput, removed);
          // rs drops exactly ONE item per rejected probe — fine on its 200k
          // windows where the overflow is a few k tokens. A pathological
          // thread on a 1M window can overflow by 40%+ (prod 2026-07-18
          // a1d14926: 1.42M tokens), where one-item-per-request means
          // hundreds of full-size round trips — the rs semantic ("trim from
          // the front until the summarizer fits") never completes in
          // practice. Reach the same end state in bulk: after the rs-style
          // shift, keep trimming until the byte-based estimate fits a
          // GEOMETRICALLY SHRINKING target (contextWindow × 0.85^round). The
          // estimate undercounts CJK (~chars/4), so a fixed target could
          // stall above the real limit — the shrinking target guarantees
          // each rejected probe cuts strictly deeper, converging in a few
          // rounds instead of hundreds.
          trimRounds += 1;
          if (config.contextWindow !== undefined) {
            const target = Math.max(
              1,
              Math.floor(config.contextWindow * Math.pow(0.85, trimRounds)),
            );
            while (
              summarizerInput.length > 1 &&
              estimateItemsTokenCount(summarizerInput) > target
            ) {
              const next = summarizerInput.shift();
              if (next) removeCorrespondingFor(summarizerInput, next);
            }
          }
          retries = 0;
          continue;
        }
        // Nothing left to trim — mark tokens full and surface the error
        // (mirrors compact.rs:242-246).
        config.tokenState?.setFull(config.contextWindow);
        throw err;
      }
      // Transient failures back off and retry (mirrors compact.rs:248-259);
      // a terminal one — an incomplete response included (#53451) — surfaces
      // at once, leaving history untouched.
      const delay =
        retries < maxRetries ? retryDelayFor(err, retries + 1) : undefined;
      if (delay === undefined) {
        throw err;
      }
      retries += 1;
      await sleep(delay, signal);
    }
  }

  const fullSummary = `${SUMMARY_PREFIX}\n${summaryText}`;

  // Collect recent user messages from the pre-compaction history
  const userMessages = collectUserMessages(history);

  // Build replacement history and mutate in place
  const newHistory = buildCompactedHistory(userMessages, fullSummary);
  history.length = 0;
  for (const item of newHistory) history.push(item);

  return summaryText;
}
