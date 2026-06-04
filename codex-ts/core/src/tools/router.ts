/**
 * mirrors codex-rs/core/src/tools/router.rs
 *
 * Routes tool calls by name to the appropriate handler.
 * Returns the tool output string + any side-effect EventMsgs to emit.
 */

import type { EventMsg } from "../../../protocol/src/protocol.js";
import type { RequestUserInputResponse } from "../../../protocol/src/request_user_input.js";
import type { ToolSpec } from "../../../tools/src/tool_spec.js";
import { GoalToolExecutor } from "../../../ext/goal/src/tool.js";
import {
  CREATE_GOAL_TOOL_NAME,
  GET_GOAL_TOOL_NAME,
  UPDATE_GOAL_TOOL_NAME,
  createCreateGoalTool,
  createGetGoalTool,
  createUpdateGoalTool,
} from "../../../ext/goal/src/spec.js";
import {
  REQUEST_USER_INPUT_TOOL_NAME,
  normalizeRequestUserInputArgs,
  createRequestUserInputTool,
} from "./handlers/request_user_input_spec.js";
import {
  handleRequestUserInput,
  formatRequestUserInputOutput,
} from "./handlers/request_user_input.js";
import type { PendingInputs } from "./handlers/request_user_input.js";
import {
  UPDATE_PLAN_TOOL_NAME,
  createUpdatePlanTool,
  parseUpdatePlanArgs,
} from "./handlers/plan_spec.js";

export interface ToolRouterContext {
  turnId: string;
  pendingInputs: PendingInputs;
  /** Emit an event immediately — used for events that must fire before suspension */
  emitEvent: (msg: EventMsg) => void;
}

/** mirrors ToolRouter in router.rs */
export class ToolRouter {
  private readonly goalExecutor: GoalToolExecutor;

  constructor(goalExecutor: GoalToolExecutor) {
    this.goalExecutor = goalExecutor;
  }

  /** All tool specs to include in Responses API requests */
  toolSpecs(): ToolSpec[] {
    return [
      createGetGoalTool(),
      createCreateGoalTool(),
      createUpdateGoalTool(),
      createRequestUserInputTool(),
      createUpdatePlanTool(),
    ];
  }

  /**
   * Dispatch a tool call; may suspend (request_user_input).
   * Side-effect events are emitted immediately via ctx.emitEvent rather than
   * returned, so RequestUserInput fires before the turn suspends.
   */
  async dispatch(
    toolName: string,
    callId: string,
    rawArgs: unknown,
    ctx: ToolRouterContext,
  ): Promise<string> {
    const args = (typeof rawArgs === "object" && rawArgs !== null
      ? rawArgs
      : {}) as Record<string, unknown>;

    switch (toolName) {
      case GET_GOAL_TOOL_NAME: {
        const { output } = await this.goalExecutor.get();
        return output;
      }

      case CREATE_GOAL_TOOL_NAME: {
        const { output, event } = await this.goalExecutor.create(
          args["objective"] as string,
          args["token_budget"] as number | undefined,
        );
        if (event) ctx.emitEvent({ type: "ThreadGoalUpdated", event });
        return output;
      }

      case UPDATE_GOAL_TOOL_NAME: {
        const { output, event } = await this.goalExecutor.update(
          args["status"] as "complete" | "blocked",
        );
        if (event) ctx.emitEvent({ type: "ThreadGoalUpdated", event });
        return output;
      }

      case REQUEST_USER_INPUT_TOOL_NAME: {
        const normalized = normalizeRequestUserInputArgs(
          args as Parameters<typeof normalizeRequestUserInputArgs>[0],
        );
        if ("error" in normalized) {
          return JSON.stringify({ error: normalized.error });
        }
        // Emit BEFORE suspending so the client can see the event and answer
        ctx.emitEvent({
          type: "RequestUserInput",
          event: { call_id: callId, turn_id: ctx.turnId, questions: normalized.questions },
        });
        const response = await handleRequestUserInput(
          { turnId: ctx.turnId, pendingInputs: ctx.pendingInputs },
          normalized.questions,
        );
        return formatRequestUserInputOutput(response);
      }

      case UPDATE_PLAN_TOOL_NAME: {
        const parsed = parseUpdatePlanArgs(args);
        if (!parsed.ok) {
          return JSON.stringify({
            error: parsed.error,
            success: false,
          });
        }
        ctx.emitEvent({ type: "PlanUpdate", event: parsed.args });
        return "Plan updated";
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${toolName}` });
    }
  }
}
