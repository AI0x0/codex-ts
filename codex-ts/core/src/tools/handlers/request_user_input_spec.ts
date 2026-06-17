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

  return {
    type: "function",
    tool: {
      name: REQUEST_USER_INPUT_TOOL_NAME,
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

/** Normalise args from the model: ensure options exist and set isOther = true */
export function normalizeRequestUserInputArgs(args: {
  questions?: {
    id: string;
    header: string;
    question: string;
    options?: { label: string; description: string }[];
    isOther?: boolean;
    isSecret?: boolean;
  }[];
}): { questions: import("../../../../protocol/src/request_user_input.js").RequestUserInputQuestion[] } | { error: string } {
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
