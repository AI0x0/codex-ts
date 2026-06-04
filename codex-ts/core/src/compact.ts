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

// ─── Token approximation (mirrors codex-rs/utils/output-truncation) ───────────

/** ~4 chars per token — cheap approximation, good enough for budget checks */
function approxTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

// ─── History helpers ─────────────────────────────────────────────────────────

/**
 * Extract plain-text content from all user messages in history.
 * mirrors collect_user_messages in compact.rs
 */
export function collectUserMessages(history: ConversationItem[]): string[] {
  const messages: string[] = [];
  for (const item of history) {
    if (!("role" in item) || item.role !== "user") continue;
    if (typeof item.content === "string") {
      if (item.content) messages.push(item.content);
    } else if (Array.isArray(item.content)) {
      const text = item.content
        .filter((p): p is { type: "input_text"; text: string } => p.type === "input_text")
        .map((p) => p.text)
        .join("\n");
      if (text) messages.push(text);
    }
  }
  return messages;
}

/**
 * Build the replacement history from recent user messages + summary.
 * mirrors build_compacted_history_with_limit in compact.rs:
 *   - Walk user messages in reverse, filling up to COMPACT_USER_MESSAGE_MAX_TOKENS
 *   - Append the summary as the final user message
 */
export function buildCompactedHistory(
  userMessages: string[],
  summaryText: string,
): ConversationItem[] {
  const maxTokens = COMPACT_USER_MESSAGE_MAX_TOKENS;
  let remaining = maxTokens;
  const selected: string[] = [];

  for (let i = userMessages.length - 1; i >= 0; i--) {
    if (remaining === 0) break;
    const msg = userMessages[i]!;
    const tokens = approxTokenCount(msg);
    if (tokens <= remaining) {
      selected.unshift(msg);
      remaining -= tokens;
    } else {
      selected.unshift(truncateToTokens(msg, remaining));
      break;
    }
  }

  const history: ConversationItem[] = [];
  for (const text of selected) {
    history.push({ role: "user", content: [{ type: "input_text", text }] });
  }

  const finalSummary = summaryText || "(no summary available)";
  history.push({ role: "user", content: [{ type: "input_text", text: finalSummary }] });

  return history;
}

// ─── Compaction request ───────────────────────────────────────────────────────

/**
 * Run an inline compaction turn:
 *   1. Send SUMMARIZATION_PROMPT + current history to the model
 *   2. Collect the assistant's summary text
 *   3. Build replacement history and mutate `history` in-place
 *
 * mirrors run_inline_auto_compact_task + run_compact_task_inner_impl in compact.rs
 * Returns the raw summary text (without SUMMARY_PREFIX).
 */
export async function runInlineAutoCompactTask(
  history: ConversationItem[],
  config: TurnConfig,
): Promise<string> {
  // Build the compaction request: full history + the summarization prompt at the end
  const compactInput: ConversationItem[] = [
    ...history,
    { role: "user", content: SUMMARIZATION_PROMPT },
  ];

  const body: Record<string, unknown> = {
    model: config.model,
    input: compactInput,
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
  });

  if (!res.ok || !res.body) {
    const text = res.body ? await res.text() : "(no body)";
    throw new Error(`Compaction request failed ${res.status}: ${text}`);
  }

  // Collect the assistant's summary text from the stream
  let summaryText = "";
  for await (const raw of parseSseStream(res.body)) {
    if (raw["type"] === "response.output_text.delta") {
      summaryText += String(raw["delta"] ?? "");
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
