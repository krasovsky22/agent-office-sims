/**
 * How the runner stops, on a signal or a crash alike: its agents are stopped
 * and waited for, up to a grace, and any still alive then are killed outright
 * before it exits. An agent the office no longer shows must not keep working,
 * or spending, after the runner that started it is gone.
 */

export interface ShutdownOptions {
  /** Stops the loops and every agent; settles once those agents have exited and their worktrees are given up. */
  readonly stop: () => Promise<unknown>;
  /** Settles once every worktree being made or removed is done: one left half-removed would read as work to keep. */
  readonly settled: () => Promise<unknown>;
  /** Longest it waits for both. */
  readonly graceMs: number;
  /** Kills every agent process group still alive. */
  readonly kill: () => void;
  readonly exit: (code: number) => void;
}

/** The runner's shutdown, run once whatever asks for it again: a second signal, or a crash while it stops. */
export function createShutdown(options: ShutdownOptions): (code: number) => void {
  let started = false;
  return (code) => {
    if (started) {
      return;
    }
    started = true;
    let exited = false;
    const exit = (): void => {
      if (exited) {
        return;
      }
      exited = true;
      clearTimeout(grace);
      options.kill();
      options.exit(code);
    };
    const grace = setTimeout(exit, options.graceMs);
    // A stop that throws only ends the wait early: whatever is left is still killed.
    void Promise.resolve()
      .then(options.stop)
      .then(options.settled)
      .catch(() => undefined)
      .then(exit);
  };
}
