/**
 * mirrors codex-rs/protocol/src/plan_tool.rs
 */

/** mirrors StepStatus enum */
export type StepStatus = "pending" | "in_progress" | "completed";

/** mirrors PlanItemArg struct */
export interface PlanItemArg {
  step: string;
  status: StepStatus;
}

/** mirrors UpdatePlanArgs struct */
export interface UpdatePlanArgs {
  explanation?: string | undefined;
  plan: PlanItemArg[];
}
