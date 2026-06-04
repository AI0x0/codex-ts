/**
 * mirrors codex-rs/thread-store/src/live_thread.rs
 *
 * LiveThread — handle for an active thread's persistence lifecycle.
 * Keeps persistence details inside so session code stays clean.
 */

import type { ThreadStore } from "./store.js";
import type { ConversationItem, RolloutItem } from "./types.js";
import type { EventMsg } from "../../protocol/src/protocol.js";

export class LiveThread {
  private readonly threadId: string;
  private readonly store: ThreadStore;

  constructor(threadId: string, store: ThreadStore) {
    this.threadId = threadId;
    this.store = store;
  }

  /** Persist one or more conversation items */
  async appendConversationItems(items: ConversationItem[]): Promise<void> {
    const rolloutItems: RolloutItem[] = items.map((item) => ({
      kind: "ConversationItem",
      item,
    }));
    await this.store.appendItems({
      threadId: this.threadId,
      items: rolloutItems,
    });
  }

  /** Persist a key event (TurnStarted, TurnComplete, etc.) */
  async appendEvent(msg: EventMsg): Promise<void> {
    await this.store.appendItems({
      threadId: this.threadId,
      items: [{ kind: "EventMsg", msg }],
    });
  }

  /** Load conversation history for resume */
  async loadConversationHistory(): Promise<ConversationItem[]> {
    const history = await this.store.loadHistory({
      threadId: this.threadId,
    });
    return history.items
      .filter((item): item is Extract<RolloutItem, { kind: "ConversationItem" }> =>
        item.kind === "ConversationItem",
      )
      .map((item) => item.item);
  }
}
