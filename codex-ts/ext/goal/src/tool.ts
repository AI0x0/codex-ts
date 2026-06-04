/**
 * mirrors codex-rs/ext/goal/src/tool.rs
 *
 * GoalToolExecutor — handles create_goal, get_goal, update_goal.
 *
 * Accepts an optional GoalStore for durable persistence (SQLite, IndexedDB…).
 * Falls back to in-memory state when no store is supplied.
 */

import type {
  ThreadGoal,
  ThreadGoalStatus,
  ThreadGoalUpdatedEvent,
} from "../../../protocol/src/protocol.js";
import type { GoalStore } from "../../../state/src/runtime/goals.js";

interface GoalToolResponse {
  goal: ThreadGoal | null;
  remaining_tokens: number | null;
  completion_budget_report?: string | undefined;
}

export class GoalToolExecutor {
  /** In-memory snapshot — always current, written through to store when present */
  private snapshot: ThreadGoal | null = null;
  private readonly threadId: string;
  private readonly store?: GoalStore | undefined;

  constructor(threadId: string, store?: GoalStore) {
    this.threadId = threadId;
    this.store = store;
  }

  // ─── create_goal ────────────────────────────────────────────────────────────

  async create(
    objective: string,
    token_budget?: number,
  ): Promise<{ output: string; event: ThreadGoalUpdatedEvent | null }> {
    if (this.snapshot !== null) {
      return {
        output: JSON.stringify({ error: "A goal already exists. Use update_goal to change its status." }),
        event: null,
      };
    }
    if (!objective) {
      return { output: JSON.stringify({ error: "objective is required." }), event: null };
    }
    if (token_budget !== undefined && (token_budget <= 0 || !Number.isInteger(token_budget))) {
      return { output: JSON.stringify({ error: "token_budget must be a positive integer." }), event: null };
    }

    const goal: ThreadGoal = {
      objective,
      status: "Active",
      ...(token_budget !== undefined ? { token_budget } : {}),
      tokens_used: 0,
      time_used_seconds: 0,
    };

    if (this.store) {
      await this.store.replaceThreadGoal(
        this.threadId,
        objective,
        "Active",
        token_budget,
      );
    }
    this.snapshot = goal;
    return { output: this.formatResponse(), event: this.goalUpdatedEvent() };
  }

  // ─── get_goal ───────────────────────────────────────────────────────────────

  async get(): Promise<{ output: string; event: null }> {
    if (this.store) {
      this.snapshot = await this.store.getThreadGoal(this.threadId);
    }
    return { output: this.formatResponse(), event: null };
  }

  // ─── update_goal ────────────────────────────────────────────────────────────

  async update(
    status: "complete" | "blocked",
  ): Promise<{ output: string; event: ThreadGoalUpdatedEvent | null }> {
    if (this.snapshot === null) {
      return { output: JSON.stringify({ error: "No active goal exists." }), event: null };
    }
    if (status !== "complete" && status !== "blocked") {
      return {
        output: JSON.stringify({ error: `Invalid status "${String(status)}". Must be "complete" or "blocked".` }),
        event: null,
      };
    }

    const goalStatus: ThreadGoalStatus = status === "complete" ? "Complete" : "Blocked";

    if (this.store) {
      await this.store.updateThreadGoal(this.threadId, { status: goalStatus });
    }
    this.snapshot = { ...this.snapshot, status: goalStatus };
    return { output: this.formatResponse(), event: this.goalUpdatedEvent() };
  }

  // ─── Token accounting ───────────────────────────────────────────────────────

  async recordTokens(count: number, elapsedSeconds = 0): Promise<void> {
    if (this.snapshot === null) return;
    if (this.store) {
      const outcome = await this.store.accountTokens(this.threadId, count, elapsedSeconds);
      if (outcome.kind === "Updated") {
        this.snapshot = outcome.goal;
        return;
      }
    }
    this.snapshot = {
      ...this.snapshot,
      tokens_used: this.snapshot.tokens_used + count,
      time_used_seconds: this.snapshot.time_used_seconds + elapsedSeconds,
    };
  }

  currentSnapshot(): ThreadGoal | null {
    return this.snapshot ? { ...this.snapshot } : null;
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private formatResponse(): string {
    if (this.snapshot === null) {
      return JSON.stringify({ goal: null, remaining_tokens: null } satisfies GoalToolResponse);
    }
    const remaining_tokens =
      this.snapshot.token_budget !== undefined
        ? this.snapshot.token_budget - this.snapshot.tokens_used
        : null;
    return JSON.stringify({ goal: this.snapshot, remaining_tokens } satisfies GoalToolResponse);
  }

  private goalUpdatedEvent(): ThreadGoalUpdatedEvent | null {
    return this.snapshot ? { goal: { ...this.snapshot } } : null;
  }
}
