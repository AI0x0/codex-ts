/**
 * A small approval surface for hosts that need interactive approvals.
 *
 * The first DOTV release uses an OS-enforced fixed writable root, so no model
 * approval is required. This module keeps the approval vocabulary in codex-ts
 * so Electron/CLI hosts can share the same state machine without making the
 * core package process-aware.
 */

export type SandboxPermissionMode =
  | "use_default"
  | "with_additional_permissions"
  | "require_escalated";

export type ReviewDecision =
  | { action: "approved" }
  | { action: "approved_for_session" }
  | { action: "denied"; reason: string }
  | { action: "abort"; reason: string };

export interface CommandApprovalRequest {
  callId: string;
  turnId: string;
  command: string;
  workdir: string;
  mode: SandboxPermissionMode;
}

/** Return null to run without asking. Return a decision after asking the user. */
export interface ApprovalCoordinator {
  requestCommandApproval(
    request: CommandApprovalRequest,
  ): Promise<ReviewDecision | null>;
}

export type ApprovalAsk = (
  request: CommandApprovalRequest,
) => Promise<ReviewDecision | null>;

export function createApprovalCoordinator(
  ask: ApprovalAsk,
): ApprovalCoordinator {
  return { requestCommandApproval: ask };
}

/** Fixed-root backends do not expose escalation to the model. */
export function deniedEscalationDecision(): ReviewDecision {
  return {
    action: "denied",
    reason:
      "Permission escalation is unavailable: commands are restricted to the host's writable root.",
  };
}

export function deniedInstruction(reason: string): string {
  return [
    "The user or host denied this command.",
    reason,
    "Do not retry the same command. Ask for clarification or use an allowed non-privileged approach.",
  ].join(" ");
}
