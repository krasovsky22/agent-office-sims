/**
 * The project board's poll loop, and the last snapshot it got right.
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
 *
 * A change the CEO made to an issue from the board, closed or reopened by an
 * agent runner, asks for a {@link ProjectFeed.refresh}, so the board catches up
 * within seconds rather than at the next scheduled poll.
 *
 * A player can ask for one too, from the board's Refresh button, through
 * {@link ProjectFeed.refreshNow}: that polls at once and answers when it is
 * done. Every player shares one allowance of those, so a room full of people
 * pressing it costs GitHub one request every {@link MIN_ASKED_REFRESH_GAP_MS},
 * and a press while a poll is in flight waits for that poll rather than
 * starting another.
 */

import { isDeepStrictEqual } from "node:util";

import { EMPTY_BOARD_LISTS, type ProjectBoardLists, type ProjectBoardSnapshot } from "@sim/shared";

import { type BoardLoader, GithubRateLimitError } from "./client.js";

/** What a room needs from the feed: the current snapshot, and news of the next. */
export interface ProjectBoardSource {
  current(): ProjectBoardSnapshot | undefined;
  /** @returns a function that unsubscribes. */
  subscribe(listener: (snapshot: ProjectBoardSnapshot) => void): () => void;
  /**
   * Fetches now, for a player who asked; absent from a source that cannot.
   *
   * @returns `null` once the fetch is done, or how many milliseconds until
   * another may be asked for when this one was refused.
   */
  refreshNow?(): Promise<number | null>;
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

/**
 * Shortest time between the start of one poll and a refresh's, so a CEO
 * dragging cards about cannot turn into a poll per drop.
 */
const MIN_REFRESH_GAP_MS = 5_000;

/** Shortest time between one player's refresh of the board and the next, whoever asks. */
export const MIN_ASKED_REFRESH_GAP_MS = 10_000;

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
  /** The lists the last published fetch brought, to tell a poll with news from one without. */
  private lists: ProjectBoardLists | undefined;
  private readonly listeners = new Set<(snapshot: ProjectBoardSnapshot) => void>();
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = new AbortController();
  private running = false;
  /** A refresh was asked for while a poll was in flight, which may have started before the change. */
  private refreshAfterPoll = false;
  private lastPollAt = Number.NEGATIVE_INFINITY;
  /** The last poll was rate limited, and the wait for the next is GitHub's, which no refresh may cut short. */
  private backingOff = false;
  /** When the poll the timer is waiting on is due, epoch milliseconds. */
  private nextPollAt = Number.NEGATIVE_INFINITY;
  /** The poll running now, which a player's refresh waits on rather than starting another. */
  private inFlight: Promise<void> | undefined;
  private lastAskedAt = Number.NEGATIVE_INFINITY;
  /** A player is waiting on the poll in flight, and should see the board's time move even if nothing else did. */
  private publishUnchanged = false;

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

  /**
   * Polls again soon, rather than at the next scheduled time: something just
   * changed on GitHub that the board should show.
   *
   * Never sooner than {@link MIN_REFRESH_GAP_MS} after the last poll started,
   * and a poll already in flight is followed by another, since it may have
   * asked before the change. A rate limit's wait is left alone.
   */
  public refresh(): void {
    if (!this.running) {
      return;
    }
    if (this.timer === undefined) {
      this.refreshAfterPoll = true;
      return;
    }
    if (this.backingOff) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = undefined;
    this.schedule(this.refreshDelay());
  }

  /**
   * Polls now, for a player who pressed Refresh, and resolves once that poll
   * is done; see {@link ProjectBoardSource.refreshNow}.
   *
   * A poll already in flight is waited on instead of a new one. Otherwise one
   * is started only {@link MIN_ASKED_REFRESH_GAP_MS} after the last a player
   * asked for, and never inside a rate limit's wait.
   */
  public async refreshNow(): Promise<number | null> {
    if (!this.running) {
      return null;
    }
    if (this.inFlight === undefined) {
      const now = this.now();
      const readyAt = Math.max(this.lastAskedAt + MIN_ASKED_REFRESH_GAP_MS, this.backingOff ? this.nextPollAt : now);
      if (readyAt > now) {
        return readyAt - now;
      }
      this.lastAskedAt = now;
      clearTimeout(this.timer);
      this.timer = undefined;
      this.run();
    }
    this.publishUnchanged = true;
    await this.inFlight;
    return null;
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
   * stale, or nothing when the lists have not changed.
   *
   * Never rejects. Exposed for the tests and for {@link start}'s loop.
   *
   * @returns how long to wait before polling again.
   */
  public async poll(): Promise<number> {
    this.lastPollAt = this.now();
    const signal = AbortSignal.any([this.stopped.signal, AbortSignal.timeout(this.timeoutMs)]);
    try {
      const lists = await this.options.load(signal);
      const asked = this.publishUnchanged;
      this.publishUnchanged = false;
      this.backingOff = false;
      const recovered = this.snapshot?.stale === true;
      if (recovered) {
        this.options.log?.(`project board: GitHub feed for ${this.options.repository} recovered`);
      } else if (!asked && isDeepStrictEqual(lists, this.lists)) {
        // Most polls find the board as it was, often from a `304`; sending it
        // again would hand every client the whole board for nothing.
        return this.options.intervalMs;
      }
      this.lists = lists;
      this.publish({
        repository: this.options.repository,
        ...lists,
        updatedAt: this.now(),
        stale: false,
      });
      return this.options.intervalMs;
    } catch (error) {
      this.publishUnchanged = false;
      if (this.stopped.signal.aborted) {
        return this.options.intervalMs;
      }
      if (error instanceof GithubRateLimitError) {
        this.backingOff = true;
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

  private refreshDelay(): number {
    return Math.max(0, this.lastPollAt + MIN_REFRESH_GAP_MS - this.now());
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

  /** Polls, then schedules the next. */
  private run(): void {
    const run = this.stopped;
    const polled = this.poll().then((next) => {
      if (this.inFlight === polled) {
        this.inFlight = undefined;
      }
      // A stop and a restart while this poll was in flight started a new
      // loop already; this one ends here rather than running beside it.
      if (this.running && run === this.stopped) {
        // A rate limit's longer wait still wins over a refresh.
        const refresh = this.refreshAfterPoll && !this.backingOff;
        this.refreshAfterPoll = false;
        this.schedule(refresh ? this.refreshDelay() : next);
      }
    });
    this.inFlight = polled;
  }

  private schedule(delayMs: number): void {
    this.nextPollAt = this.now() + delayMs;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.run();
    }, delayMs);
    // A poll timer alone should not keep the process alive; the server's
    // listening socket does that.
    this.timer.unref();
  }
}
