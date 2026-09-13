/**
 * Host-side command backend contract.
 *
 * codex-ts owns the model-facing schema, policy checks and result formatting.
 * The backend owns process creation and the OS sandbox. Nothing in this folder
 * may import Node/Electron/browser process APIs: those belong to the embedding
 * application.
 */

export const COMMAND_TIMEOUT_MAX_MS = 10 * 60 * 1000;
export const COMMAND_TIMEOUT_DEFAULT_MS = 60 * 1000;
export const COMMAND_TIMEOUT_MIN_MS = 1_000;
export const COMMAND_OUTPUT_MAX_CHARS = 200_000;
export const COMMAND_TEXT_MAX_CHARS = 32_000;

export type CommandShell = "zsh" | "cmd" | "none";
export type CommandSandbox = "seatbelt" | "restricted-token" | "unsupported";

/** Static capabilities reported by the process host before tools are injected. */
export interface CommandCapabilities {
  supported: boolean;
  /** A host-readable reason when supported is false. */
  reason?: string | undefined;
  platform: string;
  sandbox: CommandSandbox;
  shell: CommandShell;
  /** The only writable directory; commands may read any path permitted to the user. */
  writableRoot: string;
  networkOutbound: boolean;
  maxTimeoutMs: number;
  maxOutputChars: number;
}

export interface CommandStartRequest {
  /** Host correlation id; it is not a security boundary. */
  commandId: string;
  command: string;
  workdir?: string | undefined;
  timeoutMs?: number | undefined;
}

export interface CommandRunResult {
  commandId: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
  truncated: boolean;
  writableRoot: string;
  spawnError?: string | undefined;
}

/** Process backend supplied by Electron, CLI, tests, or another embedding app. */
export interface CommandHostBackend {
  capabilities(): Promise<CommandCapabilities>;
  run(request: CommandStartRequest): Promise<CommandRunResult>;
}

export type CommandToolReport = {
  start: (command: string) => string;
  end: (key: string, output: string) => void;
};

export function isCommandCapabilities(
  value: unknown,
): value is CommandCapabilities {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.supported === "boolean" &&
    typeof candidate.platform === "string" &&
    typeof candidate.writableRoot === "string" &&
    typeof candidate.networkOutbound === "boolean" &&
    typeof candidate.maxTimeoutMs === "number" &&
    typeof candidate.maxOutputChars === "number"
  );
}
