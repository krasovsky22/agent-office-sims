/**
 * Where the desk sessions work: a scratch worktree of the default branch per
 * session, under `<RUNNER_DATA_DIR>/desks`, discarded whatever is in it as the
 * session ends.
 *
 * A desk session is the CEO's own terminal for as long as the CEO sits at the
 * desk, not a task with work to hand in: what the CEO wants kept, the CEO has
 * its agent commit on a branch and push. So nothing in its worktree is kept,
 * as nothing in a standing run's is, and a session that a restart cut short
 * left its worktree behind for the next boot to discard.
 */

import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { DeskWorkspaces } from "./slots.js";
import type { Worktrees } from "./worktrees.js";

export interface DeskWorktreesOptions {
  readonly worktrees: Pick<Worktrees, "createScratch" | "removeScratch">;
  /** The folder the sessions' worktrees go in. */
  readonly root: string;
  readonly log?: (line: string) => void;
  /** Epoch milliseconds, which tell one session's folder from the slot's last. */
  readonly now?: () => number;
}

/** The desk sessions' worktrees, with any a restart left discarded as it starts. */
export function deskWorktrees(options: DeskWorktreesOptions): DeskWorkspaces {
  const log = options.log ?? (() => undefined);
  const now = options.now ?? (() => Date.now());
  mkdirSync(options.root, { recursive: true, mode: 0o700 });
  for (const stale of readdirSync(options.root)) {
    void options.worktrees.removeScratch(join(options.root, stale)).then((failed) => {
      log(failed === undefined ? `removed the desk session's worktree ${stale} a restart left` : `could not remove ${stale}: ${failed}`);
    });
  }
  return {
    open: (slotId) => options.worktrees.createScratch(join(options.root, `${slotId}-${now()}`)),
    close: async (workdir) => {
      const failed = await options.worktrees.removeScratch(workdir);
      if (failed !== undefined) {
        log(`could not remove the desk session's worktree at ${workdir}: ${failed}`);
      }
    },
  };
}
