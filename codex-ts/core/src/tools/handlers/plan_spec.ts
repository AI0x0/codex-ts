/**
 * mirrors codex-rs/core/src/tools/handlers/plan_spec.rs
 */

import type { ToolSpec } from "../../../../tools/src/tool_spec.js";
import * as S from "../../../../tools/src/json_schema.js";

export const UPDATE_PLAN_TOOL_NAME = "update_plan";

export function createUpdatePlanTool(): ToolSpec {
  const planItemSchema = S.object(
    {
      step: S.string("Task step text."),
      status: S.stringEnum(
        ["pending", "in_progress", "completed"],
        "Step status.",
      ),
    },
    ["step", "status"],
    false,
  );

  return {
    type: "function",
    tool: {
      name: UPDATE_PLAN_TOOL_NAME,
      description: `Updates the task plan.
Provide an optional explanation and a list of plan items, each with a step and status.
At most one step can be in_progress at a time.`,
      parameters: S.object(
        {
          explanation: S.string("Optional explanation for this plan update."),
          plan: S.array(planItemSchema, "The list of steps"),
        },
        ["plan"],
        false,
      ),
      strict: false,
    },
  };
}

export function parseUpdatePlanArgs(rawArgs: unknown): {
  ok: true;
  args: import("../../../../protocol/src/plan_tool.js").UpdatePlanArgs;
} | { ok: false; error: string } {
  if (typeof rawArgs !== "object" || rawArgs === null) {
    return { ok: false, error: "failed to parse function arguments: expected object" };
  }

  const obj = rawArgs as Record<string, unknown>;

  if (!Array.isArray(obj["plan"])) {
    return { ok: false, error: "failed to parse function arguments: plan must be an array" };
  }

  const plan = (obj["plan"] as unknown[]).map((item, i) => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`plan[${i}] must be an object`);
    }
    const it = item as Record<string, unknown>;
    if (typeof it["step"] !== "string") throw new Error(`plan[${i}].step must be a string`);
    const status = it["status"];
    if (status !== "pending" && status !== "in_progress" && status !== "completed") {
      throw new Error(`plan[${i}].status must be pending, in_progress, or completed`);
    }
    return { step: it["step"] as string, status: status as import("../../../../protocol/src/plan_tool.js").StepStatus };
  });

  const explanation =
    typeof obj["explanation"] === "string" ? obj["explanation"] : undefined;

  return { ok: true, args: { plan, ...(explanation !== undefined ? { explanation } : {}) } };
}
