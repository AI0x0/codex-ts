/**
 * mirrors codex-rs/core/src/tools/handlers/request_user_input_spec.rs
 */

import type { ToolSpec } from "../../../../tools/src/tool_spec.js";
import * as S from "../../../../tools/src/json_schema.js";

export const REQUEST_USER_INPUT_TOOL_NAME = "request_user_input";
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
    'Provide 2-4 mutually exclusive choices. Put the recommended option first and suffix its label with "(Recommended)". ' +
      'Do not include an "Other" option; the client adds one automatically.',
  );

  const questionSchema = S.object(
    {
      id: S.string("Stable identifier for mapping answers (snake_case)."),
      header: S.string(
        "Short header label shown in the UI (12 or fewer chars).",
      ),
      question: S.string("Single-sentence prompt shown to the user."),
      options: optionsSchema,
    },
    ["id", "header", "question", "options"],
    false,
  );

  return {
    type: "function",
    tool: {
      name: REQUEST_USER_INPUT_TOOL_NAME,
      // mirrors request_user_input_tool_description (request_user_input_spec.rs:138).
      // The rs "only available in {allowed_modes}" clause is dropped: codex-ts has
      // no collaboration modes, so the tool is always available.
      description:
        "Request user input for one to three short questions and wait for the response.",
      parameters: S.object(
        {
          questions: S.array(
            questionSchema,
            "Questions to show the user. Prefer 1 and do not exceed 3.",
          ),
        },
        ["questions"],
        false,
      ),
      strict: false,
    },
  };
}

/** A value the model sent as text. Blank counts as missing, as in do-tv's ask-shape guard. */
function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every shape problem in the model's questions, named by path; [] when the
 * shape is fine. The rules match do-tv's askShapeProblems
 * (packages/web/app/(frontend)/features/agent/ask-shape.ts): keep them in sync.
 */
function requestUserInputProblems(questions: unknown[]): string[] {
  const problems: string[] = [];
  for (const [qi, raw] of questions.entries()) {
    const at = `questions[${qi}]`;
    if (!isRecord(raw)) {
      problems.push(`${at} must be an object`);
      continue;
    }
    if (!isText(raw.id)) {
      problems.push(`${at}.id must be a non-empty string`);
    }
    if (!isText(raw.question)) {
      problems.push(`${at}.question must be a non-empty string`);
    }
    if (raw.header !== undefined && typeof raw.header !== "string") {
      problems.push(`${at}.header must be a string`);
    }
    if (!Array.isArray(raw.options) || raw.options.length === 0) {
      problems.push(`${at}.options must be a non-empty array`);
      continue;
    }
    for (const [oi, rawOption] of raw.options.entries()) {
      const optionAt = `${at}.options[${oi}]`;
      if (!isRecord(rawOption)) {
        problems.push(`${optionAt} must be an object`);
        continue;
      }
      if (!isText(rawOption.label)) {
        problems.push(`${optionAt}.label must be a non-empty string`);
      }
      if (
        rawOption.description !== undefined &&
        typeof rawOption.description !== "string"
      ) {
        problems.push(`${optionAt}.description must be a string`);
      }
    }
  }
  return problems;
}

/**
 * The tool error for a call the model has to redo. The card is not shown, so
 * nothing is emitted and the turn does not suspend.
 */
function requestUserInputRetryError(problems: string[]): { error: string } {
  return {
    error: `request_user_input was NOT shown to the user: ${problems.join("; ")}. Call request_user_input again with corrected arguments.`,
  };
}

/**
 * Normalise args from the model: reject a malformed shape, set isOther = true.
 * mirrors normalize_request_user_input_tool_args (request_user_input_spec.rs:104).
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
    }
  | { error: string } {
  // The model can omit `questions` (or send a non-array) under strict:false;
  // guard before iterating so we return a tool error instead of throwing
  // "undefined is not an object (evaluating 'args.questions')".
  if (!Array.isArray(args.questions) || args.questions.length === 0) {
    return requestUserInputRetryError(["questions must be a non-empty array"]);
  }
  // Under strict:false nothing else checks the shape, and a card the client
  // cannot draw breaks the whole turn; hand the call back to the model instead.
  const problems = requestUserInputProblems(args.questions);
  if (problems.length > 0) {
    return requestUserInputRetryError(problems);
  }
  return {
    questions: args.questions.map((q) => ({
      id: q.id,
      header: q.header,
      question: q.question,
      options: q.options,
      isOther: true,
      isSecret: q.isSecret ?? false,
    })),
  };
}
