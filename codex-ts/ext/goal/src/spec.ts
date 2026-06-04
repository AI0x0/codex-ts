/**
 * mirrors codex-rs/ext/goal/src/spec.rs
 *
 * Tool schemas for create_goal, get_goal, update_goal.
 */

import type { ToolSpec } from "../../../tools/src/tool_spec.js";
import * as S from "../../../tools/src/json_schema.js";

export const GET_GOAL_TOOL_NAME = "get_goal";
export const CREATE_GOAL_TOOL_NAME = "create_goal";
export const UPDATE_GOAL_TOOL_NAME = "update_goal";

export function createGetGoalTool(): ToolSpec {
  return {
    type: "function",
    tool: {
      name: GET_GOAL_TOOL_NAME,
      description:
        "Get the current goal for this thread, including status, budgets, token and elapsed-time usage, and remaining token budget.",
      parameters: S.object({}, [], false),
      strict: false,
    },
  };
}

export function createCreateGoalTool(): ToolSpec {
  return {
    type: "function",
    tool: {
      name: CREATE_GOAL_TOOL_NAME,
      description: [
        "Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks.",
        `Set token_budget only when an explicit token budget is requested. Fails if a goal exists; use ${UPDATE_GOAL_TOOL_NAME} only for status.`,
      ].join("\n"),
      parameters: S.object(
        {
          objective: S.string(
            "Required. The concrete objective to start pursuing. " +
              "This starts a new active goal only when no goal is currently defined; " +
              "if a goal already exists, this tool fails.",
          ),
          token_budget: S.integer(
            "Optional positive token budget for the new active goal.",
          ),
        },
        ["objective"],
        false,
      ),
      strict: false,
    },
  };
}

export function createUpdateGoalTool(): ToolSpec {
  return {
    type: "function",
    tool: {
      name: UPDATE_GOAL_TOOL_NAME,
      description: [
        "Update the existing goal.",
        "Use this tool only to mark the goal achieved or blocked.",
        "Set status to `complete` only when the objective has actually been achieved and no required work remains.",
        "Set status to `blocked` only when the goal cannot currently proceed until something external changes.",
        "Do not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work.",
      ].join("\n"),
      parameters: S.object(
        {
          status: S.stringEnum(
            ["complete", "blocked"],
            "Required. Set to complete only when the objective is achieved and no required work remains. " +
              "Set to blocked only when the goal cannot currently proceed without a user decision, " +
              "missing dependency, or external unblock.",
          ),
        },
        ["status"],
        false,
      ),
      strict: false,
    },
  };
}
