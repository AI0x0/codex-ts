/**
 * mirrors codex-rs/protocol/src/protocol.rs
 *
 * Subset: Op + EventMsg variants needed for goal, request_user_input,
 * and conversation (turn lifecycle + streaming text).
 */

import type { UserInput } from "./user_input.js";
import type {
  RequestUserInputEvent,
  RequestUserInputResponse,
} from "./request_user_input.js";
import type { UpdatePlanArgs } from "./plan_tool.js";

// ─── ThreadGoal ────────────────────────────────────────────────────────────────

export type ThreadGoalStatus =
  | "Active"
  | "Paused"
  | "Blocked"
  | "UsageLimited"
  | "BudgetLimited"
  | "Complete";

export interface ThreadGoal {
  objective: string;
  status: ThreadGoalStatus;
  token_budget?: number | undefined;
  tokens_used: number;
  time_used_seconds: number;
}

// ─── Event payloads ────────────────────────────────────────────────────────────

export interface TurnStartedEvent {
  turn_id: string;
}

export interface TurnCompleteEvent {
  turn_id: string;
  last_agent_message?: string | undefined;
}

/** Full assistant text for a completed message */
export interface AgentMessageEvent {
  message: string;
}

/** Streaming text chunk — mirrors AgentMessageContentDeltaEvent */
export interface AgentMessageContentDeltaEvent {
  turn_id: string;
  item_id: string;
  delta: string;
}

export interface ThreadGoalUpdatedEvent {
  turn_id?: string | undefined;
  goal: ThreadGoal;
}

export interface ErrorEvent {
  message: string;
  /**
   * Browser-specific extension — no equivalent in codex-rs/protocol ErrorEvent.
   * Lets hosts correlate an error with the turn that produced it (e.g. to
   * suppress stale-turn errors after an Interrupt).
   */
  turn_id?: string | undefined;
}

// ─── EventMsg ─────────────────────────────────────────────────────────────────

export type EventMsg =
  | { type: "TurnStarted"; event: TurnStartedEvent }
  | { type: "TurnComplete"; event: TurnCompleteEvent }
  | { type: "AgentMessage"; event: AgentMessageEvent }
  | { type: "AgentMessageContentDelta"; event: AgentMessageContentDeltaEvent }
  | { type: "RequestUserInput"; event: RequestUserInputEvent }
  | { type: "ThreadGoalUpdated"; event: ThreadGoalUpdatedEvent }
  | { type: "PlanUpdate"; event: UpdatePlanArgs }
  | { type: "Error"; event: ErrorEvent };

/** Wraps EventMsg with the submission_id that originated it — mirrors codex-rs Event */
export interface Event {
  /** submission_id returned by CodexThread.submit() */
  id: string;
  msg: EventMsg;
}

// ─── Op ───────────────────────────────────────────────────────────────────────

// =============================================================================
// Browser-specific adaptation of Op::UserInput.
//
// codex-rs/protocol/src/protocol.rs carries a full `ThreadSettingsOverrides`
// struct on UserInput (cwd, approval_policy, sandbox_policy, permission_profile,
// collaboration_mode, …). These fields are native-only and meaningless in the
// browser, so we expose only the two that are relevant: per-turn model and
// per-turn instructions. Functionally equivalent to the subset of
// ThreadSettingsOverrides::model and
// ThreadSettingsOverrides::collaboration_mode.settings.developer_instructions.
// =============================================================================

export type Op =
  | {
      type: "UserInput";
      items: UserInput[];
      /**
       * Per-turn instructions override. Subset of ThreadSettingsOverrides in
       * codex-rs. Falls back to the thread's instructions when omitted.
       */
      instructions?: string | undefined;
      /**
       * Per-turn model override. Subset of ThreadSettingsOverrides in codex-rs.
       * Falls back to the thread's model when omitted.
       */
      model?: string | undefined;
    }
  | {
      type: "UserInputAnswer";
      /** RequestUserInputEvent.turn_id — identifies which turn to unblock */
      id: string;
      response: RequestUserInputResponse;
    }
  | { type: "Interrupt" };

export type { RequestUserInputEvent, RequestUserInputResponse };
export type { UpdatePlanArgs } from "./plan_tool.js";
export type { StepStatus, PlanItemArg } from "./plan_tool.js";
