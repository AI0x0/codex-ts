/**
 * mirrors codex-rs/core/src/tools/handlers/request_user_input_spec.rs
 */

import type { ToolSpec } from "../../../../tools/src/tool_spec.js";
import * as S from "../../../../tools/src/json_schema.js";

export const REQUEST_USER_INPUT_TOOL_NAME = "request_user_input";
/** mirrors MIN/MAX_AUTO_RESOLUTION_MS (request_user_input_spec.rs:9-10) */
export const MIN_AUTO_RESOLUTION_MS = 60_000;
export const MAX_AUTO_RESOLUTION_MS = 240_000;

export function createRequestUserInputTool(): ToolSpec {
  const optionSchema = S.object(
    {
      label: S.string("User-facing label (1-5 words)."),
      description: S.string(
        "One short sentence explaining impact/tradeoff if selected.",
      ),
    },
    ["label", "description"],
    false,
  );

  const optionsSchema = S.array(
    optionSchema,
    'Provide 2-3 mutually exclusive choices. Put the recommended option first and suffix its label with "(Recommended)". ' +
      'Do not include an "Other" option; the client adds one automatically.',
  );

  const questionSchema = S.object(
    {
      id: S.string("Stable identifier for mapping answers (snake_case)."),
      header: S.string("Short header label shown in the UI (12 or fewer chars)."),
      question: S.string("Single-sentence prompt shown to the user."),
      options: optionsSchema,
    },
    ["id", "header", "question", "options"],
    false,
  );

  // mirrors auto_resolution_ms_schema (request_user_input_spec.rs:71)
  const autoResolutionMsSchema = S.number(
    `Optional auto-resolution window in milliseconds, from ${MIN_AUTO_RESOLUTION_MS} to ${MAX_AUTO_RESOLUTION_MS}. ` +
      "Include this only when the question is useful but non-blocking and continuing with best judgment is acceptable " +
      "if the user does not answer; omit it when explicit user input is required before continuing. " +
      `Use ${MIN_AUTO_RESOLUTION_MS} for lightly helpful context and up to ${MAX_AUTO_RESOLUTION_MS} when the answer ` +
      "would materially unblock better work.",
  );

  return {
    type: "function",
    tool: {
      name: REQUEST_USER_INPUT_TOOL_NAME,
      // mirrors request_user_input_tool_description (request_user_input_spec.rs:138).
      // The rs "only available in {allowed_modes}" clause is dropped: codex-ts has
      // no collaboration modes, so the tool is always available.
      description:
        "Request user input for one to three short questions and wait for the response. " +
        `Set autoResolutionMs, from ${MIN_AUTO_RESOLUTION_MS} to ${MAX_AUTO_RESOLUTION_MS} milliseconds, only when ` +
        "the question is useful but non-blocking and continuing with best judgment is acceptable if the user does " +
        "not answer; omit it when explicit user input is required.",
      parameters: S.object(
        {
          questions: S.array(
            questionSchema,
            "Questions to show the user. Prefer 1 and do not exceed 3.",
          ),
          autoResolutionMs: autoResolutionMsSchema,
        },
        ["questions"],
        false,
      ),
      strict: false,
    },
  };
}

/**
 * Normalise args from the model: ensure options exist, set isOther = true, and
 * clamp autoResolutionMs into the supported range.
 * mirrors normalize_request_user_input_args (request_user_input_spec.rs:104).
 */
export function normalizeRequestUserInputArgs(args: {
  questions?: {
    id: string;
    header: string;
    question: string;
    options?: { label: string; description: string }[];
    isOther?: boolean;
    isSecret?: boolean;
  }[];
  autoResolutionMs?: unknown;
}):
  | {
      questions: import("../../../../protocol/src/request_user_input.js").RequestUserInputQuestion[];
      autoResolutionMs?: number | undefined;
    }
  | { error: string } {
  // The model can omit `questions` (or send a non-array) under strict:false;
  // guard before iterating so we return a tool error instead of throwing
  // "undefined is not an object (evaluating 'args.questions')".
  if (!Array.isArray(args.questions) || args.questions.length === 0) {
    return {
      error: "request_user_input requires a non-empty `questions` array",
    };
  }
  for (const q of args.questions) {
    if (!q.options || q.options.length === 0) {
      return {
        error: "request_user_input requires non-empty options for every question",
      };
    }
  }
  // mirrors the auto_resolution_ms clamp (request_user_input_spec.rs:123): an
  // out-of-range window is pulled into [MIN, MAX] rather than rejected. A
  // non-numeric value (strict:false lets the model send anything) is dropped.
  const rawAutoResolutionMs = args.autoResolutionMs;
  const autoResolutionMs =
    typeof rawAutoResolutionMs === "number" && Number.isFinite(rawAutoResolutionMs)
      ? Math.min(
          MAX_AUTO_RESOLUTION_MS,
          Math.max(MIN_AUTO_RESOLUTION_MS, Math.trunc(rawAutoResolutionMs)),
        )
      : undefined;

  return {
    questions: args.questions.map((q) => ({
      id: q.id,
      header: q.header,
      question: q.question,
      options: q.options,
      isOther: true,
      isSecret: q.isSecret ?? false,
    })),
    ...(autoResolutionMs !== undefined ? { autoResolutionMs } : {}),
  };
}
