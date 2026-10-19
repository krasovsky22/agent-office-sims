/**
 * The feed's promises are about failure: that the last good snapshot outlives
 * a bad poll, that it says it is stale, and that a rate limit slows the loop
 * rather than spending more requests. The loader here is a stub, so every
 * outcome is chosen by the test.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { EMPTY_BOARD_LISTS, type ProjectBoardLists, type ProjectBoardSnapshot } from "@sim/shared";

import { type BoardLoader, GithubRateLimitError } from "./client.js";
import { ProjectFeed } from "./feed.js";

const REPO = "krasovsky22/agent-office-sims";
const INTERVAL = 60_000;

const LISTS: ProjectBoardLists = {
  ...EMPTY_BOARD_LISTS,
  open: [{ number: 32, title: "Project board", body: "", labels: [], assignees: [], pullRequests: [], closedAt: null }],
  counts: { open: 1, inProgress: 0, pullRequests: 0 },
};

/** A loader that plays back a script of outcomes, one per poll. */
function scripted(...outcomes: (ProjectBoardLists | Error)[]): BoardLoader {
  let index = 0;
  return async () => {
    const outcome = outcomes[Math.min(index, outcomes.length - 1)];
    index += 1;
    if (outcome instanceof Error || outcome === undefined) {
      throw outcome ?? new Error("script ran out");
    }
    return outcome;
  };
}

function feedWith(load: BoardLoader, now = () => 1_000) {
  const published: ProjectBoardSnapshot[] = [];
  const log: string[] = [];
  const feed = new ProjectFeed({ repository: REPO, load, intervalMs: INTERVAL, now, log: (line) => log.push(line) });
  feed.subscribe((snapshot) => published.push(snapshot));
  return { feed, published, log };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ProjectFeed", () => {
  it("has nothing to show before its first poll", () => {
    expect(feedWith(scripted(LISTS)).feed.current()).toBeUndefined();
  });

  it("publishes a fresh snapshot after a successful poll", async () => {
    const { feed, published } = feedWith(scripted(LISTS), () => 5_000);

    await expect(feed.poll()).resolves.toBe(INTERVAL);

    const expected: ProjectBoardSnapshot = { repository: REPO, ...LISTS, updatedAt: 5_000, stale: false };
    expect(feed.current()).toEqual(expected);
    expect(published).toEqual([expected]);
  });

  it("keeps the last good lists and marks them stale when a poll fails", async () => {
    const { feed, published, log } = feedWith(scripted(LISTS, new TypeError("fetch failed")));

    await feed.poll();
    await feed.poll();

    expect(feed.current()).toEqual({ repository: REPO, ...LISTS, updatedAt: 1_000, stale: true });
    expect(published).toHaveLength(2);
    expect(log).toEqual([expect.stringContaining("stale (fetch failed)")]);
  });

  it("announces staleness once, not on every failed poll", async () => {
    const { feed, published, log } = feedWith(scripted(LISTS, new Error("down")));

    await feed.poll();
    await feed.poll();
    await feed.poll();
    await feed.poll();

    expect(published).toHaveLength(2);
    expect(log).toHaveLength(1);
  });

  it("publishes an empty stale board when the very first poll fails", async () => {
    const { feed } = feedWith(scripted(new Error("down")));
    await feed.poll();
    expect(feed.current()).toEqual({ repository: REPO, ...EMPTY_BOARD_LISTS, updatedAt: null, stale: true });
  });

  it("clears the stale marker on the next poll that succeeds", async () => {
    let clock = 1_000;
    const { feed, log } = feedWith(scripted(LISTS, new Error("down"), LISTS), () => clock);

    await feed.poll();
    await feed.poll();
    clock = 9_000;
    await feed.poll();

    expect(feed.current()?.stale).toBe(false);
    expect(feed.current()?.updatedAt).toBe(9_000);
    expect(log[1]).toContain("recovered");
  });

  it("waits out a rate limit until GitHub's reset time", async () => {
    const now = () => 1_000_000;
    const { feed } = feedWith(scripted(new GithubRateLimitError(now() + 10 * 60_000)), now);
    await expect(feed.poll()).resolves.toBe(10 * 60_000);
    expect(feed.current()?.stale).toBe(true);
  });

  it("never waits less than the interval, or more than an hour, for a rate limit", async () => {
    const now = () => 1_000_000;
    await expect(feedWith(scripted(new GithubRateLimitError(now() + 1)), now).feed.poll()).resolves.toBe(INTERVAL);
    await expect(
      feedWith(scripted(new GithubRateLimitError(now() + 24 * 3_600_000)), now).feed.poll(),
    ).resolves.toBe(3_600_000);
  });

  it("treats a poll that never answers as a failure", async () => {
    const hanging: BoardLoader = (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      });
    const feed = new ProjectFeed({ repository: REPO, load: hanging, intervalMs: INTERVAL, timeoutMs: 20 });

    await feed.poll();

    expect(feed.current()?.stale).toBe(true);
  });

  it("keeps publishing to the other listeners when one throws", async () => {
    const { feed, published } = feedWith(scripted(LISTS));
    feed.subscribe(() => {
      throw new Error("room gone");
    });
    await expect(feed.poll()).resolves.toBe(INTERVAL);
    expect(published).toHaveLength(1);
  });

  it("stops telling a listener once it unsubscribes", async () => {
    const feed = new ProjectFeed({ repository: REPO, load: scripted(LISTS), intervalMs: INTERVAL });
    const heard: ProjectBoardSnapshot[] = [];
    const unsubscribe = feed.subscribe((snapshot) => heard.push(snapshot));
    unsubscribe();
    await feed.poll();
    expect(heard).toEqual([]);
  });

  it("polls at once on start, then once per interval, until stopped", async () => {
    vi.useFakeTimers();
    const load = vi.fn(scripted(LISTS));
    const feed = new ProjectFeed({ repository: REPO, load, intervalMs: INTERVAL });

    feed.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(load).toHaveBeenCalledTimes(2);

    feed.stop();
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(load).toHaveBeenCalledTimes(2);
    expect(feed.current()?.stale).toBe(false);
  });

  it("polls again soon on a refresh, but not sooner than the gap after the last poll", async () => {
    vi.useFakeTimers();
    const load = vi.fn(scripted(LISTS));
    const feed = new ProjectFeed({ repository: REPO, load, intervalMs: INTERVAL });

    feed.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);

    feed.refresh();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(load).toHaveBeenCalledTimes(2);

    // And the loop goes back to its interval afterwards.
    await vi.advanceTimersByTimeAsync(INTERVAL - 1);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(3);
    feed.stop();
  });

  it("follows a poll in flight with another when refreshed during it", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const load = vi.fn(
      () =>
        new Promise<ProjectBoardLists>((resolve) => {
          release = () => resolve(LISTS);
        }),
    );
    const feed = new ProjectFeed({ repository: REPO, load, intervalMs: INTERVAL });

    feed.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    feed.refresh();
    await vi.advanceTimersByTimeAsync(1_000);
    release?.();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(load).toHaveBeenCalledTimes(2);
    feed.stop();
  });

  it("ignores a refresh while stopped", async () => {
    vi.useFakeTimers();
    const load = vi.fn(scripted(LISTS));
    const feed = new ProjectFeed({ repository: REPO, load, intervalMs: INTERVAL });
    feed.refresh();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(load).not.toHaveBeenCalled();
  });
});
