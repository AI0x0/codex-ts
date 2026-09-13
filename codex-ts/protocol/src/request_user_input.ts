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
}
