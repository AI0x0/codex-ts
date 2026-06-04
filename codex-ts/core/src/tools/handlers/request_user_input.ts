/**
 * mirrors codex-rs/core/src/tools/handlers/request_user_input.rs
 *
 * Suspends the current turn until the client submits a UserInputAnswer op.
 * The resolver is stored in a map keyed by turn_id and resolved when
 * CodexThread.submit({ type: "UserInputAnswer", id: turn_id, response })
 * is called.
 */

import type {
  RequestUserInputQuestion,
  RequestUserInputResponse,
} from "../../../../protocol/src/request_user_input.js";

export type PendingInputs = Map<
  string,
  (response: RequestUserInputResponse) => void
>;

export interface RequestUserInputContext {
  turnId: string;
  pendingInputs: PendingInputs;
}

export async function handleRequestUserInput(
  ctx: RequestUserInputContext,
  _questions: RequestUserInputQuestion[],
): Promise<RequestUserInputResponse> {
  return new Promise<RequestUserInputResponse>((resolve) => {
    ctx.pendingInputs.set(ctx.turnId, resolve);
  });
}

export function formatRequestUserInputOutput(
  response: RequestUserInputResponse,
): string {
  return JSON.stringify(response);
}
