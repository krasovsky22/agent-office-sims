/**
 * The lobby board's poll loop, and the last snapshot it got right.
 *
 * This runs on its own timer, outside every room's simulation tick, and that
 * separation is the point of the module. A GitHub request takes hundreds of
 * milliseconds on a good day and never returns on a bad one; the tick runs
 * every 50ms and must never wait on anything. So the feed fetches on its own
 * schedule, keeps the newest good snapshot in memory, and tells subscribers
 * when it has a new one. A room reading {@link ProjectFeed.current} gets an
 * answer immediately, whatever GitHub is doing.
 *
 * One feed serves the whole process, however many rooms it holds, so the
 * request rate is set by the poll interval and not by the player count.
 *
 * Failure is expected, not exceptional. A network error, a timeout, or a spent
 * rate limit keeps the previous lists and marks the snapshot stale, and the
 * board says so; the next poll that succeeds clears it. A rate limit also
 * pushes the next poll out to when GitHub says the limit resets, rather than
 * spending the next window's requests on refusals.
 */

import { EMPTY_BOARD_LISTS, type ProjectBoardSnapshot } from "@sim/shared";

import { type BoardLoader, GithubRateLimitError } from "./client.js";

/** What a room needs from the feed: the current snapshot, and news of the next. */
export interface ProjectBoardSource {
  current(): ProjectBoardSnapshot | undefined;
  /** @returns a function that unsubscribes. */
  subscribe(listener: (snapshot: ProjectBoardSnapshot) => void): () => void;
}

export interface ProjectFeedOptions {
  /** `owner/name`, carried into every snapshot. */
  readonly repository: string;
  readonly load: BoardLoader;
  /** Time from the end of one poll to the start of the next. */
  readonly intervalMs: number;
  /** How long one poll may take before it is abandoned as a failure. */
  readonly timeoutMs?: number;
  /** Epoch milliseconds. Injected so a test controls the clock. */
  readonly now?: () => number;
  /**
   * Told when the feed goes stale and when it recovers — once each, not on
   * every failed poll, so a long outage is two log lines rather than hundreds.
   */
  readonly log?: (line: string) => void;
}

/** A poll that has not answered in this long has failed. */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Longest a rate limit may push the next poll out.
 *
 * GitHub's primary window is an hour, so this is a ceiling on a wrong or
 * missing reset header, not a delay anyone should normally see.
 */
const MAX_BACKOFF_MS = 60 * 60 * 1000;

function describeFailure(error: unknown): string {
  if (error instanceof GithubRateLimitError) {
    return "rate limited";
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return "timed out";
  }
  return error instanceof Error && error.message !== "" ? error.message : "request failed";
}

export class ProjectFeed implements ProjectBoardSource {
  private snapshot: ProjectBoardSnapshot | undefined;
  private readonly listeners = new Set<(snapshot: ProjectBoardSnapshot) => void>();
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = new AbortController();
  private running = false;

  public constructor(private readonly options: ProjectFeedOptions) {
    this.now = options.now ?? (() => Date.now());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  public current(): ProjectBoardSnapshot | undefined {
    return this.snapshot;
  }

  public subscribe(listener: (snapshot: ProjectBoardSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Polls now, then keeps polling until {@link stop}. */
  public start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.stopped = new AbortController();
    this.schedule(0);
  }

  /** Stops polling and abandons a poll in flight. The last snapshot stays readable. */
  public stop(): void {
    this.running = false;
    this.stopped.abort();
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * One poll: fetch, then publish either the new lists or the old ones marked
   * stale.
   *
   * Never rejects. Exposed for the tests and for {@link start}'s loop.
   *
   * @returns how long to wait before polling again.
   */
  public async poll(): Promise<number> {
    const signal = AbortSignal.any([this.stopped.signal, AbortSignal.timeout(this.timeoutMs)]);
    try {
      const lists = await this.options.load(signal);
      if (this.snapshot?.stale === true) {
        this.options.log?.(`project board: GitHub feed for ${this.options.repository} recovered`);
      }
      this.publish({
        repository: this.options.repository,
        ...lists,
        updatedAt: this.now(),
        stale: false,
      });
      return this.options.intervalMs;
    } catch (error) {
      if (this.stopped.signal.aborted) {
        return this.options.intervalMs;
      }
      this.markStale(describeFailure(error));
      return this.delayAfter(error);
    }
  }

  private markStale(reason: string): void {
    if (this.snapshot?.stale === true) {
      // Already showing as stale, and nothing on the board has changed.
      return;
    }
    this.options.log?.(
      `project board: GitHub feed for ${this.options.repository} is stale (${reason}); keeping the last snapshot`,
    );
    this.publish({
      repository: this.options.repository,
      ...EMPTY_BOARD_LISTS,
      updatedAt: null,
      ...this.snapshot,
      stale: true,
    });
  }

  private delayAfter(error: unknown): number {
    const { intervalMs } = this.options;
    if (!(error instanceof GithubRateLimitError) || error.retryAt === undefined) {
      return intervalMs;
    }
    return Math.min(MAX_BACKOFF_MS, Math.max(intervalMs, error.retryAt - this.now()));
  }

  private publish(snapshot: ProjectBoardSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // One room failing to broadcast must not stop the others hearing, or
        // the loop from scheduling its next poll.
      }
    }
  }

  private schedule(delayMs: number): void {
    const run = this.stopped;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.poll().then((next) => {
        // A stop and a restart while this poll was in flight started a new
        // loop already; this one ends here rather than running beside it.
        if (this.running && run === this.stopped) {
          this.schedule(next);
        }
      });
    }, delayMs);
    // A poll timer alone should not keep the process alive; the server's
    // listening socket does that.
    this.timer.unref();
  }
}
