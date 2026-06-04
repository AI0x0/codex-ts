/**
 * mirrors codex-rs/core/src/codex_thread.rs
 *
 * CodexThread — manages the conversation session:
 *   - submit(op)    → enqueue an Op, return submission_id  (mirrors submit())
 *   - nextEvent()   → pull the next Event                  (mirrors next_event())
 *
 * Accepts optional ThreadStore and GoalStore for durable persistence.
 * Falls back to in-memory implementations when neither is supplied.
 */

import type {
  Event,
  EventMsg,
  Op,
  TurnCompleteEvent,
  TurnStartedEvent,
} from "../../protocol/src/protocol.js";
import type { RequestUserInputResponse } from "../../protocol/src/request_user_input.js";
import { GoalToolExecutor } from "../../ext/goal/src/tool.js";
import { GoalStore, InMemoryGoalBackend } from "../../state/src/runtime/goals.js";
import {
  InMemoryThreadStore,
  LocalThreadStore,
  LiveThread,
} from "../../thread-store/src/index.js";
import type { ThreadStore, IoBackend } from "../../thread-store/src/index.js";
import type { ConversationItem } from "../../thread-store/src/types.js";
import { ToolRouter } from "./tools/router.js";
import type { CustomTool } from "./tools/router.js";
import { runTurn } from "./session/turn.js";
import { DEFAULT_BASE_INSTRUCTIONS } from "./base_instructions.js";
import { renderSkillsCatalog } from "./skills.js";
import type { SkillMetadata } from "./skills.js";
import type { TurnConfig } from "./session/turn.js";
import type { PendingInputs } from "./tools/handlers/request_user_input.js";

// ─── Async event queue (mirrors tokio mpsc) ───────────────────────────────────

type QueueEntry<T> = { done: false; value: T } | { done: true };

class AsyncQueue<T> {
  private buf: T[] = [];
  private waiters: ((entry: QueueEntry<T>) => void)[] = [];
  private closed = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.buf.push(value);
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters) w({ done: true });
    this.waiters = [];
  }

  async next(): Promise<T> {
    if (this.buf.length > 0) return this.buf.shift()!;
    if (this.closed) throw new Error("event stream closed");
    return new Promise<T>((resolve, reject) => {
      this.waiters.push((entry) => {
        if (entry.done) reject(new Error("event stream closed"));
        else resolve(entry.value);
      });
    });
  }
}

// ─── ID generation ────────────────────────────────────────────────────────────

let _seq = 0;
function nextId(): string {
  return `sub-${++_seq}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─── CodexThreadConfig ────────────────────────────────────────────────────────

export interface CodexThreadConfig {
  apiKey: string;
  baseUrl?: string | undefined;
  model: string;
  instructions?: string | undefined;
  /**
   * Thread ID to use. If omitted a new ID is generated.
   * Supply a previously used ID + a matching threadStore to resume a session.
   */
  threadId?: string | undefined;
  /**
   * Durable conversation-history store.
   * Pass an InMemoryThreadStore (default), a LocalThreadStore with your IoBackend,
   * or any custom ThreadStore implementation.
   */
  threadStore?: ThreadStore | undefined;
  /**
   * IoBackend shorthand: if you only want to inject I/O primitives without
   * wiring up a full ThreadStore, pass an IoBackend here and a LocalThreadStore
   * will be created automatically.
   */
  ioBackend?: IoBackend | undefined;
  /**
   * Durable goal store.
   * Defaults to an in-memory GoalStore (lost on reload).
   * Pass a GoalStore with a custom GoalBackend for persistence.
   */
  goalStore?: GoalStore | undefined;
  /**
   * Host-supplied custom tools. Their specs are advertised to the model
   * alongside the built-ins, and calls route to each tool's execute().
   */
  customTools?: CustomTool[] | undefined;
  /**
   * Base agent instructions prepended ahead of `instructions`. Mirrors
   * codex-rs's base_instructions layer (the agent harness that keeps the model
   * acting like a tool-calling agent). Defaults to DEFAULT_BASE_INSTRUCTIONS;
   * pass "" to disable.
   */
  baseInstructions?: string | undefined;
  /**
   * Discovered skills (name + description + path). Rendered into an always-on
   * "## Skills" catalog (Layer 1) and used to resolve `$skill-name` mentions for
   * full-body injection (Layer 2). Mirrors codex-rs's core-skills crate, except
   * discovery (scanning .agents/skills + parsing frontmatter) is the host's job
   * since a browser has no filesystem.
   */
  skills?: SkillMetadata[] | undefined;
  /** Reads a skill's full SKILL.md on demand (host-provided; browser has no fs). */
  loadSkillContent?: ((skill: SkillMetadata) => Promise<string>) | undefined;
  /**
   * Project documentation (AGENTS.md content). Mirrors codex-rs's
   * AgentsMdManager / UserInstructions fragment: injected as a discrete
   * `input` message (format: "# AGENTS.md instructions\n\n<INSTRUCTIONS>…")
   * ahead of the conversation history so the model sees it as a separate
   * context boundary — NOT merged into the `instructions` field.
   * Discovery (finding AGENTS.override.md / AGENTS.md) is the host's job
   * since a browser has no filesystem.
   */
  agentsMd?: string | undefined;
  /**
   * Input-token threshold for inline auto-compaction (BodyAfterPrefix mode).
   * mirrors model_auto_compact_token_limit in codex-rs TurnContext config.
   *
   * Recommended: context_window × 0.9  (e.g. 115 000 for gpt-4o's 128 k window).
   * Omit to disable auto-compaction entirely.
   */
  autoCompactTokenLimit?: number | undefined;
}

interface ResolvedConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  instructions?: string | undefined;
  baseInstructions: string;
  skills: SkillMetadata[];
  loadSkillContent?: ((skill: SkillMetadata) => Promise<string>) | undefined;
  agentsMd?: string | undefined;
  autoCompactTokenLimit?: number | undefined;
}

// ─── CodexThread ─────────────────────────────────────────────────────────────

export class CodexThread {
  private readonly config: ResolvedConfig;
  private readonly threadId: string;
  private readonly eventQueue = new AsyncQueue<Event>();

  /** In-flight conversation history (sent to the Responses API each turn) */
  private readonly history: ConversationItem[] = [];

  /** Pending request_user_input resolvers keyed by turn_id */
  private readonly pendingInputs: PendingInputs = new Map<
    string,
    (response: RequestUserInputResponse) => void
  >();

  private readonly goalExecutor: GoalToolExecutor;
  private readonly router: ToolRouter;
  private readonly liveThread: LiveThread;

  /**
   * AbortController for the in-flight turn, if any.
   * mirrors: codex-rs uses a tokio CancellationToken propagated from
   * Op::Interrupt; AbortController is the browser-native equivalent.
   */
  private currentTurnAbort: AbortController | null = null;

  constructor(config: CodexThreadConfig) {
    this.config = {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl ?? "https://api.openai.com/v1",
      model: config.model,
      instructions: config.instructions,
      baseInstructions: config.baseInstructions ?? DEFAULT_BASE_INSTRUCTIONS,
      skills: config.skills ?? [],
      loadSkillContent: config.loadSkillContent,
      agentsMd: config.agentsMd,
      autoCompactTokenLimit: config.autoCompactTokenLimit,
    };

    this.threadId = config.threadId ?? nextId();

    // Resolve ThreadStore: explicit > ioBackend shorthand > in-memory
    const store: ThreadStore =
      config.threadStore ??
      (config.ioBackend
        ? new LocalThreadStore(config.ioBackend)
        : new InMemoryThreadStore());

    this.liveThread = new LiveThread(this.threadId, store);

    // Resolve GoalStore
    const goalStore = config.goalStore ?? new GoalStore(new InMemoryGoalBackend());
    this.goalExecutor = new GoalToolExecutor(this.threadId, goalStore);

    this.router = new ToolRouter(this.goalExecutor, config.customTools);
  }

  /** The thread's stable identifier (use for resume) */
  get id(): string { return this.threadId; }

  /**
   * Async factory — use this instead of `new` when resuming an existing thread.
   *
   * If `config.threadId` is supplied and the backing store contains history,
   * that history is loaded into the in-flight conversation before the first
   * turn runs.  Mirrors the session-initialisation path in codex-rs where
   * `load_history()` is called during `CodexThread` construction.
   *
   * For brand-new threads `new CodexThread(config)` is equivalent.
   */
  static async create(config: CodexThreadConfig): Promise<CodexThread> {
    const thread = new CodexThread(config);
    if (config.threadId) {
      const items = await thread.liveThread.loadConversationHistory();
      thread.history.push(...items);
    }
    return thread;
  }

  /**
   * Submit an Op. Returns the submission_id.
   * Mirrors: pub async fn submit(&self, op: Op) -> CodexResult<String>
   */
  async submit(op: Op): Promise<string> {
    const submissionId = nextId();

    switch (op.type) {
      case "UserInput": {
        const turnId = submissionId;
        // Per-turn overrides (op.*) take precedence over thread-level config.
        // Developer instructions are layered on top of the base agent harness.
        const devInstructions = op.instructions ?? this.config.instructions;
        // instructions field = base agent harness + developer (app-level)
        // instructions, mirroring codex-rs where base/developer go in
        // `instructions`. Project docs + catalog ride in `input` instead.
        const instructions = [this.config.baseInstructions, devInstructions]
          .filter((part): part is string => Boolean(part))
          .join("\n\n");
        // codex-rs puts the project doc + skills catalog in `input` as discrete
        // contextual messages so each boundary is explicit to the model (see
        // TurnConfig.contextItems) rather than baked into the instructions blob.
        const contextItems: ConversationItem[] = [];
        // AGENTS.md → user_instructions message (codex-rs UserInstructions
        // fragment: # AGENTS.md instructions / <INSTRUCTIONS> markers).
        if (this.config.agentsMd) {
          contextItems.push({
            role: "user",
            content: [
              {
                type: "input_text",
                text: `# AGENTS.md instructions\n\n<INSTRUCTIONS>\n${this.config.agentsMd}\n</INSTRUCTIONS>`,
              },
            ],
          });
        }
        // skills catalog message (codex-rs available-skills fragment).
        const skillsCatalog = renderSkillsCatalog(this.config.skills);
        if (skillsCatalog) {
          contextItems.push({
            role: "user",
            content: [{ type: "input_text", text: skillsCatalog }],
          });
        }
        const turnConfig: TurnConfig = {
          apiKey: this.config.apiKey,
          baseUrl: this.config.baseUrl,
          model: op.model ?? this.config.model,
          ...(instructions ? { instructions } : {}),
          ...(contextItems.length > 0 ? { contextItems } : {}),
          ...(this.config.skills.length > 0
            ? { skills: this.config.skills }
            : {}),
          ...(this.config.loadSkillContent
            ? { loadSkillContent: this.config.loadSkillContent }
            : {}),
          ...(this.config.autoCompactTokenLimit !== undefined
            ? { autoCompactTokenLimit: this.config.autoCompactTokenLimit }
            : {}),
        };

        const abortController = new AbortController();
        this.currentTurnAbort = abortController;

        this.pushEvent(submissionId, {
          type: "TurnStarted",
          event: { turn_id: turnId } satisfies TurnStartedEvent,
        });

        void runTurn(
          turnId,
          op.items,
          this.history,
          turnConfig,
          this.router,
          this.pendingInputs,
          (msg: EventMsg) => this.pushEvent(submissionId, msg),
          this.liveThread,        // ← persistence hook
          abortController.signal, // ← interrupt hook
        )
          .then(({ lastAgentMessage }) => {
            this.pushEvent(submissionId, {
              type: "TurnComplete",
              event: {
                turn_id: turnId,
                last_agent_message: lastAgentMessage || undefined,
              } satisfies TurnCompleteEvent,
            });
          })
          .catch((err: unknown) => {
            this.pushEvent(submissionId, {
              type: "Error",
              event: { message: String(err), turn_id: turnId },
            });
          })
          .finally(() => {
            if (this.currentTurnAbort === abortController) {
              this.currentTurnAbort = null;
            }
          });
        break;
      }

      case "UserInputAnswer": {
        const resolve = this.pendingInputs.get(op.id);
        if (resolve) {
          resolve(op.response);
          this.pendingInputs.delete(op.id);
        }
        break;
      }

      case "Interrupt":
        this.currentTurnAbort?.abort();
        break;
    }

    return submissionId;
  }

  /**
   * Pull the next event. Blocks until one is available.
   * Mirrors: pub async fn next_event(&self) -> CodexResult<Event>
   */
  async nextEvent(): Promise<Event> {
    return this.eventQueue.next();
  }

  private pushEvent(submissionId: string, msg: EventMsg): void {
    this.eventQueue.push({ id: submissionId, msg });
  }
}
