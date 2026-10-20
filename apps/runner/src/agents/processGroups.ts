/**
 * Every agent process group the runner started and has not yet seen exit.
 *
 * Each agent runs as the leader of its own process group, so the runner
 * exiting does not take it along. Kept here, whoever started it, so a
 * shutdown whose grace runs out can kill whatever is still there rather than
 * leave it working, and spending, where the office cannot see it.
 */

const live = new Set<number>();

/** Keeps `pid`'s group until the returned function says it exited. */
export function trackGroup(pid: number): () => void {
  live.add(pid);
  return () => live.delete(pid);
}

/** SIGKILLs every group still kept, or its leader alone where it leads none. */
export function killLiveGroups(): void {
  for (const pid of live) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  live.clear();
}
