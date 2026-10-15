/**
 * The conversation with one room's AI manager: what the CEO said, what the
 * manager answered, and what it posted on its own.
 *
 * Kept on the server and relayed rather than replicated, like chat, but kept:
 * a player who opens the manager's panel after joining should be able to read
 * back what was asked and decided, so a joining client is handed the recent
 * lines and every new one is broadcast. Bounded, oldest dropped first, because
 * a room may stay open for days.
 */

import { type ManagerEntry, type ManagerEntryKind, sanitizeManagerReply } from "@sim/shared";

/** Lines kept: a long session's worth of questions, small enough to send on join. */
export const MAX_CONVERSATION_ENTRIES = 80;

export class ManagerConversation {
  private readonly kept: ManagerEntry[] = [];
  private nextId = 1;

  public constructor(private readonly now: () => number = () => Date.now()) {}

  /** Every line kept, oldest first. Not mutated after it is returned. */
  public entries(): readonly ManagerEntry[] {
    return [...this.kept];
  }

  /**
   * Records one line, sanitized and capped as the manager's own replies are.
   *
   * @returns the line, or `undefined` when nothing legible was left to record.
   */
  public append(kind: ManagerEntryKind, authorName: string, text: string): ManagerEntry | undefined {
    const clean = sanitizeManagerReply(text);
    if (clean === "") {
      return undefined;
    }
    const entry: ManagerEntry = { id: this.nextId, kind, authorName, text: clean, at: this.now() };
    this.nextId += 1;
    this.kept.push(entry);
    while (this.kept.length > MAX_CONVERSATION_ENTRIES) {
      this.kept.shift();
    }
    return entry;
  }
}
