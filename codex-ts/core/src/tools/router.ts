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

// =============================================================================
// Browser-specific extension — no direct equivalent in codex-rs.
//
// codex-rs registers tools via the `ToolExecutor<ToolInvocation>` trait and
// the `CoreToolRuntime` marker; TypeScript has no traits, so we expose the
// same concept as a plain interface that callers inject into CodexThread.
// =============================================================================

/**
 * Context handed to a CustomTool's execute(). Carries the identifiers a host
 * needs to correlate the call (callId / turnId) and an emitEvent escape hatch.
 */
export interface CustomToolContext {
  callId: string;
  turnId: string;
  emitEvent: (msg: EventMsg) => void;
}

/**
 * A host-supplied tool.
 *
 * TypeScript equivalent of implementing `ToolExecutor<ToolInvocation>` in
 * codex-rs: the host provides the spec (advertised to the model) and an async
 * execute() whose returned string becomes the function_call_output sent back.
 */
export interface CustomTool {
  /** Tool name as advertised to and called by the model */
  name: string;
  /** ToolSpec included in Responses API requests */
  spec(): ToolSpec;
  /** Run the call; the returned string is fed back to the model as output */
  execute(args: unknown, ctx: CustomToolContext): Promise<string>;
}

// =============================================================================
// Which built-ins are advertised — a host switch, no direct equivalent in codex-rs.
//
// codex-rs derives the built-in tool set from the session's config (sandbox
// policy, approval mode, collaboration mode). codex-ts has none of those knobs,
// so the host states it directly.
// =============================================================================

/**
 * Which built-in tools to advertise to the model. Every flag defaults to true,
 * so omitting this leaves the historical tool set unchanged.
 *
 * A registered tool costs its whole JSON schema in every request, and a host
 * whose product has no use for goals or plans pays that on every turn for a
 * tool the model must then be told not to call. Turning one off drops its spec
 * (and, for `plan`, the matching paragraph of the base instructions).
 *
 * `request_user_input` has no flag: a turn that suspends on it is the only way
 * a tool-calling agent can ask the user anything, so it is always registered.
 */
export interface BuiltinTools {
  /** get_goal / create_goal / update_goal. Default true. */
  goal?: boolean | undefined;
  /** update_plan. Default true. */
  plan?: boolean | undefined;
}

/** mirrors ToolRouter in router.rs */
export class ToolRouter {
  private readonly goalExecutor: GoalToolExecutor;
  private readonly customTools: Map<string, CustomTool>;
  private readonly builtins: Required<BuiltinTools>;

  constructor(
    goalExecutor: GoalToolExecutor,
    customTools: CustomTool[] = [],
    builtins: BuiltinTools = {},
  ) {
    this.goalExecutor = goalExecutor;
    this.customTools = new Map(customTools.map((tool) => [tool.name, tool]));
    this.builtins = {
      goal: builtins.goal ?? true,
      plan: builtins.plan ?? true,
    };
  }

  /** All tool specs to include in Responses API requests */
  toolSpecs(): ToolSpec[] {
    return [
      ...(this.builtins.goal
        ? [createGetGoalTool(), createCreateGoalTool(), createUpdateGoalTool()]
        : []),
      createRequestUserInputTool(),
      ...(this.builtins.plan ? [createUpdatePlanTool()] : []),
      ...Array.from(this.customTools.values(), (tool) => tool.spec()),
    ];
  }

  /**
   * Dispatch a tool call; may suspend (request_user_input).
   * Side-effect events are emitted immediately via ctx.emitEvent rather than
   * returned, so RequestUserInput fires before the turn suspends.
   *
   * Every built-in stays dispatchable regardless of `builtins`: that flag
   * governs what is ADVERTISED, and a thread resumed from a rollout written
   * while the tool was on must still be able to answer a call already in its
   * history. A model that was never handed the spec will not call it.
   */
  async dispatch(
    toolName: string,
    callId: string,
    rawArgs: unknown,
    ctx: ToolRouterContext,
  ): Promise<string> {
    const args = (
      typeof rawArgs === "object" && rawArgs !== null ? rawArgs : {}
    ) as Record<string, unknown>;

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
          args["status"] as "complete" | "blocked" | "paused",
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
        // Emit BEFORE suspending so the client can see the event and answer.
        ctx.emitEvent({
          type: "RequestUserInput",
          event: {
            call_id: callId,
            turn_id: ctx.turnId,
            questions: normalized.questions,
          },
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

      default: {
        const custom = this.customTools.get(toolName);
        if (custom) {
          // Hand the raw (un-normalised) args to the host; it does its own parsing.
          return custom.execute(rawArgs, {
            callId,
            turnId: ctx.turnId,
            emitEvent: ctx.emitEvent,
          });
        }
        return JSON.stringify({ error: `Unknown tool: ${toolName}` });
      }
    }
  }
}
