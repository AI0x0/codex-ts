/** mirrors codex-rs/protocol/src/request_user_input.rs */

export interface RequestUserInputQuestionOption {
  label: string;
  description: string;
}

export interface RequestUserInputQuestion {
  id: string;
  header: string;
  question: string;
  /** Injected by normalize_request_user_input_args in spec.rs */
  isOther: boolean;
  isSecret: boolean;
  options?: RequestUserInputQuestionOption[] | undefined;
}

export interface RequestUserInputArgs {
  questions: RequestUserInputQuestion[];
  /**
   * Optional auto-resolution window in milliseconds — mirrors
   * `auto_resolution_ms` (request_user_input.rs:34). Present only when the
   * question is useful but NON-blocking: the host may proceed with the agent's
   * best judgment if the user does not answer within the window. Clamped to
   * [MIN_AUTO_RESOLUTION_MS, MAX_AUTO_RESOLUTION_MS] by
   * normalizeRequestUserInputArgs.
   */
  autoResolutionMs?: number | undefined;
}

/** Per-question answers: key = question id */
export interface RequestUserInputAnswer {
  answers: string[];
}

export interface RequestUserInputResponse {
  answers: Record<string, RequestUserInputAnswer>;
}

/** Emitted by the agent when it calls request_user_input */
export interface RequestUserInputEvent {
  call_id: string;
  turn_id: string;
  questions: RequestUserInputQuestion[];
  /**
   * Auto-resolution window forwarded from the tool call — mirrors
   * `RequestUserInputEvent.auto_resolution_ms` (request_user_input.rs:58).
   * Absent means the agent needs an explicit answer before continuing.
   */
  autoResolutionMs?: number | undefined;
}
