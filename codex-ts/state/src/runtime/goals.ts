/**
 * mirrors codex-rs/state/src/runtime/goals.rs
 *
 * GoalBackend — injectable storage primitive for goal state.
 *
 * Implement this to persist goals to SQLite, IndexedDB, OPFS, etc.
 * The built-in InMemoryGoalBackend works in all environments without I/O.
 *
 * GoalStore wraps a GoalBackend and adds accounting (token budget tracking).
 */

import type { ThreadGoal, ThreadGoalStatus } from "../../../protocol/src/protocol.js";

// ─── GoalBackend ───────────────────────────────────────────────────────────────

export interface GoalBackend {
  getThreadGoal(threadId: string): Promise<ThreadGoal | null>;
  saveThreadGoal(threadId: string, goal: ThreadGoal): Promise<void>;
  deleteThreadGoal(threadId: string): Promise<void>;
}

// ─── InMemoryGoalBackend ───────────────────────────────────────────────────────

export class InMemoryGoalBackend implements GoalBackend {
  private readonly store = new Map<string, ThreadGoal>();

  async getThreadGoal(threadId: string): Promise<ThreadGoal | null> {
    return this.store.get(threadId) ?? null;
  }

  async saveThreadGoal(threadId: string, goal: ThreadGoal): Promise<void> {
    this.store.set(threadId, { ...goal });
  }

  async deleteThreadGoal(threadId: string): Promise<void> {
    this.store.delete(threadId);
  }
}

// ─── GoalUpdate — mirrors GoalUpdate in goals.rs ──────────────────────────────

export interface GoalUpdate {
  status?: ThreadGoalStatus | undefined;
  token_budget?: number | null | undefined;
}

// ─── GoalAccountingOutcome — mirrors GoalAccountingOutcome in goals.rs ─────────

export type GoalAccountingOutcome =
  | { kind: "Unchanged"; goal: ThreadGoal | null }
  | { kind: "Updated"; goal: ThreadGoal };

// ─── GoalStore ────────────────────────────────────────────────────────────────

export class GoalStore {
  private readonly backend: GoalBackend;

  constructor(backend: GoalBackend = new InMemoryGoalBackend()) {
    this.backend = backend;
  }

  async getThreadGoal(threadId: string): Promise<ThreadGoal | null> {
    return this.backend.getThreadGoal(threadId);
  }

  /** Create or replace a thread goal (mirrors replace_thread_goal, goals.rs:158) */
  async replaceThreadGoal(
    threadId: string,
    objective: string,
    status: ThreadGoalStatus,
    token_budget?: number,
  ): Promise<ThreadGoal> {
    const now = Date.now();
    const goal: ThreadGoal = {
      thread_id: threadId,
      objective,
      status,
      ...(token_budget !== undefined ? { token_budget } : {}),
      tokens_used: 0,
      time_used_seconds: 0,
      created_at: now,
      updated_at: now,
    };
    await this.backend.saveThreadGoal(threadId, goal);
    return goal;
  }

  /**
   * Create a goal only when the thread has no goal, or its goal is already
   * complete. mirrors create_thread_goal (goals.rs:225): upstream changed the
   * `ON CONFLICT(thread_id) DO NOTHING` to `DO UPDATE … WHERE status =
   * 'complete'`, so a finished goal is replaced (usage counters reset to 0)
   * while an UNFINISHED goal still blocks creation. Returns null when blocked.
   */
  async createThreadGoal(
    threadId: string,
    objective: string,
    token_budget?: number,
  ): Promise<ThreadGoal | null> {
    const existing = await this.getThreadGoal(threadId);
    if (existing !== null && existing.status !== "Complete") {
      return null;
    }
    return this.replaceThreadGoal(threadId, objective, "Active", token_budget);
  }

  /** Apply a partial update to an existing goal */
  async updateThreadGoal(
    threadId: string,
    update: GoalUpdate,
  ): Promise<GoalAccountingOutcome> {
    const existing = await this.getThreadGoal(threadId);
    if (existing === null) {
      return { kind: "Unchanged", goal: null };
    }
    const updated: ThreadGoal = {
      ...existing,
      ...(update.status !== undefined ? { status: update.status } : {}),
      ...(update.token_budget !== undefined
        ? update.token_budget === null
          ? {}
          : { token_budget: update.token_budget }
        : {}),
      updated_at: Date.now(),
    };
    await this.backend.saveThreadGoal(threadId, updated);
    return { kind: "Updated", goal: updated };
  }

  /**
   * Delete the thread's goal and return what was removed (null when there was
   * none). mirrors delete_thread_goal (goals.rs:472), which upstream changed
   * from `bool` to the deleted row so callers can report/emit it.
   */
  async deleteThreadGoal(threadId: string): Promise<ThreadGoal | null> {
    const existing = await this.getThreadGoal(threadId);
    if (existing === null) {
      return null;
    }
    await this.backend.deleteThreadGoal(threadId);
    return existing;
  }

  /**
   * Record token and time usage against the active goal budget.
   * Mirrors the accounting path in GoalStore::account_tokens().
   */
  async accountTokens(
    threadId: string,
    tokens: number,
    elapsedSeconds: number,
  ): Promise<GoalAccountingOutcome> {
    const existing = await this.getThreadGoal(threadId);
    if (existing === null || existing.status !== "Active") {
      return { kind: "Unchanged", goal: existing };
    }
    const tokens_used = existing.tokens_used + tokens;
    const time_used_seconds = existing.time_used_seconds + elapsedSeconds;
    let status: ThreadGoalStatus = existing.status;

    // Budget exhaustion → UsageLimited
    if (
      existing.token_budget !== undefined &&
      tokens_used >= existing.token_budget
    ) {
      status = "UsageLimited";
    }

    const updated: ThreadGoal = {
      ...existing,
      tokens_used,
      time_used_seconds,
      status,
      updated_at: Date.now(),
    };
    await this.backend.saveThreadGoal(threadId, updated);
    const changed = status !== existing.status || tokens_used !== existing.tokens_used;
    return changed
      ? { kind: "Updated", goal: updated }
      : { kind: "Unchanged", goal: updated };
  }
}
