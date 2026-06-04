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

export type Op =
  | { type: "UserInput"; items: UserInput[] }
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
