/**
 * The standing tasks' scheduler, with the mock's scripted runs on a real slot
 * pool: what a task's first look leaves alone, what it reviews once, what it
 * skips, how issue work takes a slot back, how the caps hold, what a restart
 * keeps, when a schedule fires, what the steward merges and resolves and
 * when, a hired agent's task on its slot alone, a new schedule, and the
 * record each run leaves for the wall board.
 *
 * The clock the scheduler reads is the test's, and each look is a `tick` the
 * test calls; the mock's steps run on real, very short timers.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_STANDING_CAPS,
  type PullState,
  RUNNER_COMMAND_KIND,
  type RunnerEvent,
  type RunnerSlotCommand,
  type RunnerStandingRunEvent,
  type StandingTaskSpec,
} from "@sim/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Agent } from "../agents/types.js";
import { SpendLedger } from "../budget.js";
import { SlotPool } from "../slots.js";
import { MOCK_STANDING_STEP_USD, createMockStandingRunners } from "./mock.js";
import type { OpenPull, PullListing, PullSource } from "./pulls.js";
import { StandingScheduler, type StandingSchedulerOptions } from "./scheduler.js";
import { StandingStore } from "./store.js";
import type { StandingRunners } from "./types.js";

const PR_TASK: StandingTaskSpec = {
  id: "st-prwatch1",
  kind: "pr-review",
  name: "Watch for new pull requests",
  paused: false,
  note: "",
  version: 1,
  caps: DEFAULT_STANDING_CAPS,
  intervalSeconds: 120,
  authors: "collaborators",
};

const STEWARD_TASK: StandingTaskSpec = {
  id: "st-steward1",
  kind: "pr-steward",
  name: "Review, fix and merge pull requests",
  paused: false,
  note: "",
  version: 1,
  caps: DEFAULT_STANDING_CAPS,
  intervalSeconds: 120,
};

const SCHEDULE_TASK: StandingTaskSpec = {
  id: "st-morning1",
  kind: "schedule",
  name: "Morning summary",
  paused: false,
  note: "",
  version: 1,
  caps: DEFAULT_STANDING_CAPS,
  cron: "0 9 * * 1-5",
  instruction: "Summarise what changed.",
};

function pull(number: number, overrides: Partial<OpenPull> = {}): OpenPull {
  return { number, title: `Change ${number}`, draft: false, author: "dana", association: "OWNER", ownAgent: false, headSha: `sha${number}`, ...overrides };
}

/** An agent that starts and does nothing, so an issue's start only holds its slot. */
const IDLE_AGENT: Agent = { label: "Mock", start: () => ({ stop: () => Promise.resolve() }) };

let dir: string;
let clock: number;
let listing: OpenPull[];
let polls: number;
let ledger: SpendLedger;

/** GitHub as the test says it is: the listing changes only when the test changes it. */
const source: PullSource = async (etag): Promise<PullListing> => {
  polls += 1;
  const tag = JSON.stringify(listing);
  return etag === tag ? { kind: "unchanged" } : { kind: "listed", etag: tag, pulls: [...listing] };
};

function makePool(): SlotPool {
  return new SlotPool({
    count: 2,
    agent: IDLE_AGENT,
    workspaces: { open: async () => dir, close: async () => undefined },
    taskTimeoutMs: 60_000,
    ledger,
  });
}

function makeScheduler(pool: SlotPool, options: Partial<StandingSchedulerOptions> = {}, runners?: StandingRunners): StandingScheduler {
  let id = 0;
  return new StandingScheduler({
    store: new StandingStore({ file: join(dir, "standing.json") }),
    pool,
    runners: runners ?? createMockStandingRunners({ stepMs: 2, minPollIntervalMs: 0 }),
    pulls: source,
    ledger,
    budgetUsd: undefined,
    maxConcurrent: 1,
    now: () => clock,
    eventId: () => `event-${(id += 1)}`,
    ...options,
  });
}

function set(scheduler: StandingScheduler, spec: StandingTaskSpec): void {
  scheduler.handle({ id: "c-set", kind: RUNNER_COMMAND_KIND.standingSet, spec, requestedBy: "Dana" });
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) {
      throw new Error("timed out waiting");
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function runs(events: readonly RunnerEvent[]): Array<[string, number | undefined]> {
  return events
    .filter((event): event is RunnerStandingRunEvent => event.kind === "standing-run")
    .map((event) => [event.outcome, event.pr?.number]);
}

/** A pull request as the steward reads it: open at `headSha`, every required check as `ci` says. */
function pullState(headSha: string, overrides: Partial<PullState> = {}): PullState {
  return {
    open: true,
    draft: false,
    headSha,
    headRef: "feature",
    baseRef: "main",
    baseSha: "base000",
    crossRepository: false,
    mergeable: "MERGEABLE",
    mergeState: "CLEAN",
    checks: [{ name: "ci", state: "pass", required: true }],
    checksTruncated: false,
    ...overrides,
  };
}

/** The mock's runs, with GitHub's merge states as the test sets them, and the merges and resolves kept rather than made. */
function stewardRunners(states: Map<number, PullState>) {
  const merged: Array<readonly [number, string]> = [];
  const resolved: number[] = [];
  const runners: StandingRunners = {
    ...createMockStandingRunners({ stepMs: 2, minPollIntervalMs: 0 }),
    inspect: async (number) => {
      const state = states.get(number);
      if (state === undefined) {
        throw new Error(`no PR #${number}`);
      }
      return state;
    },
    merge: async (job) => {
      merged.push([job.pr?.number ?? 0, job.pr?.headSha ?? ""]);
      job.lease.output("\u001b[32mmerged\u001b[0m\r\n");
      return { outcome: "merged", costUsd: 0, message: "Squash-merged." };
    },
    resolve: async (job) => {
      resolved.push(job.pr?.number ?? 0);
      return { outcome: "resolved", costUsd: 0, message: "Pushed." };
    },
  };
  return { runners, merged, resolved };
}

/** Moves the clock on past the poll interval and looks again. */
function later(scheduler: StandingScheduler, ms = 121_000): void {
  clock += ms;
  scheduler.tick();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sim-standing-"));
  clock = new Date(2026, 9, 19, 8, 0).getTime();
  listing = [];
  polls = 0;
  ledger = new SpendLedger({ budgetUsd: undefined, now: () => new Date(clock) });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("a pull request watch", () => {
  it("leaves what was open alone, and reviews a new collaborator's pull request once, on a slot it then frees", async () => {
    const pool = makePool();
    const scheduler = makeScheduler(pool);
    listing = [pull(10), pull(11)];
    set(scheduler, PR_TASK);
    await until(() => scheduler.report()[0]?.lastCheckAt !== undefined);
    expect(scheduler.report()[0]).toMatchObject({ status: "active", queued: 0, trigger: "every 2 min" });

    listing = [pull(10), pull(11), pull(12)];
    later(scheduler);
    await until(() => pool.report().some((slot) => slot.standing !== undefined));
    expect(pool.report()[0]).toMatchObject({ status: "working", standing: { taskId: PR_TASK.id, pr: 12 }, issueNumber: undefined });
    expect(scheduler.report()[0]?.status).toBe("running");
    await until(() => runs(scheduler.pendingEvents()).length === 1);
    expect(runs(scheduler.pendingEvents())).toEqual([["simulated", 12]]);
    expect(pool.report()[0]).toMatchObject({ status: "idle" });
    expect(pool.report()[0]?.standing).toBeUndefined();

    // Looked at again, nothing new: nothing more runs.
    later(scheduler);
    await until(() => polls >= 3);
    expect(runs(scheduler.pendingEvents())).toEqual([["simulated", 12]]);
    const task = scheduler.report()[0];
    expect(task).toMatchObject({ handledToday: 1, queued: 0, recent: [{ outcome: "simulated", pr: 12 }] });
    expect(task?.spentTodayUsd).toBeCloseTo(MOCK_STANDING_STEP_USD * 4);
    expect(ledger.report().spentUsd).toBeCloseTo(MOCK_STANDING_STEP_USD * 4);
  });

  it("skips a draft until it is ready, and an outside contributor's for good, saying so", async () => {
    const scheduler = makeScheduler(makePool());
    set(scheduler, PR_TASK);
    await until(() => polls === 1);
    listing = [pull(20, { draft: true }), pull(21, { association: "CONTRIBUTOR", author: "stranger" }), pull(22, { association: "NONE", ownAgent: true, draft: true })];
    later(scheduler);
    await until(() => polls === 2);
    expect(runs(scheduler.pendingEvents())).toEqual([["skipped", 21]]);
    const skipped = scheduler.pendingEvents().find((event) => event.kind === "standing-run");
    expect(skipped).toMatchObject({ message: "It is by stranger, an outside contributor, so it was not reviewed." });

    listing = [pull(20), pull(21, { association: "CONTRIBUTOR", author: "stranger" }), pull(22, { association: "NONE", ownAgent: true })];
    later(scheduler);
    await until(() => runs(scheduler.pendingEvents()).length === 3);
    expect(runs(scheduler.pendingEvents())).toEqual([
      ["skipped", 21],
      ["simulated", 20],
      ["simulated", 22],
    ]);
  });

  it("gives its slot up to issue work at once, and reviews the pull request again later", async () => {
    const pool = makePool();
    const scheduler = makeScheduler(pool, {}, createMockStandingRunners({ stepMs: 30, minPollIntervalMs: 0 }));
    set(scheduler, PR_TASK);
    await until(() => polls === 1);
    listing = [pull(30)];
    later(scheduler);
    await until(() => pool.report()[0]?.standing !== undefined);

    const start: RunnerSlotCommand = {
      id: "c-start",
      slotId: "slot-1",
      kind: "start",
      issueNumber: 39,
      title: "Night shift",
      url: "https://github.com/o/r/issues/39",
      note: "",
      requestedBy: "Dana",
    };
    pool.handle(start);
    expect(pool.report()[0]).toMatchObject({ issueNumber: 39 });
    expect(pool.report()[0]?.standing).toBeUndefined();
    await until(() => runs(scheduler.pendingEvents()).length >= 1);
    expect(runs(scheduler.pendingEvents())[0]).toEqual(["preempted", 30]);
    // Run again on the slot still free.
    await until(() => runs(scheduler.pendingEvents()).length === 2);
    expect(runs(scheduler.pendingEvents())[1]).toEqual(["simulated", 30]);
    const second = scheduler.pendingEvents().filter((event) => event.kind === "standing-run")[1];
    expect(second).toMatchObject({ slotId: "slot-2" });
    // Issue work took slot 1, and kept it: no event of its own was lost.
    expect(pool.pendingEvents().some((event) => event.kind === "failed")).toBe(false);
  });

  it("counts its spend and caps nothing with no standing budget", async () => {
    const scheduler = makeScheduler(makePool());
    set(scheduler, PR_TASK);
    await until(() => polls === 1);
    listing = [pull(40), pull(41), pull(42)];
    later(scheduler);
    await until(() => runs(scheduler.pendingEvents()).length === 3);
    expect(runs(scheduler.pendingEvents())).toEqual([
      ["simulated", 40],
      ["simulated", 41],
      ["simulated", 42],
    ]);
    const report = scheduler.report()[0];
    expect(report).toMatchObject({ status: "active", dailyUsd: undefined });
    expect(report?.spentTodayUsd).toBeGreaterThan(0);
  });

  it("starts nothing more once it reaches the runs an hour it was set, until that hour has passed", async () => {
    const scheduler = makeScheduler(makePool());
    set(scheduler, { ...PR_TASK, caps: { ...DEFAULT_STANDING_CAPS, maxRunsPerHour: 1 } });
    await until(() => polls === 1);
    listing = [pull(50), pull(51)];
    later(scheduler);
    await until(() => runs(scheduler.pendingEvents()).length === 1);
    clock += 30 * 60_000;
    scheduler.tick();
    // A run limit, not a budget: it says so, with money left.
    expect(scheduler.report()[0]).toMatchObject({ status: "run-limit", nextCheckAt: undefined });
    clock += 31 * 60_000;
    scheduler.tick();
    await until(() => runs(scheduler.pendingEvents()).length === 2);
    expect(runs(scheduler.pendingEvents())).toEqual([
      ["simulated", 50],
      ["simulated", 51],
    ]);
  });

  it("starts as many runs an hour as it is asked for when it was set no limit", async () => {
    const scheduler = makeScheduler(makePool());
    set(scheduler, PR_TASK);
    await until(() => polls === 1);
    listing = Array.from({ length: 8 }, (_, at) => pull(60 + at));
    later(scheduler);
    await until(() => runs(scheduler.pendingEvents()).length === 8);
    expect(scheduler.report()[0]?.status).not.toBe("run-limit");
  });

  it("refuses a second watch, a fifth task, and pauses, resumes, checks and removes", async () => {
    const scheduler = makeScheduler(makePool());
    set(scheduler, PR_TASK);
    set(scheduler, { ...PR_TASK, id: "st-prwatch2" });
    expect(scheduler.pendingEvents()).toEqual([expect.objectContaining({ kind: "standing-refused", message: expect.stringContaining("already watches") })]);
    await until(() => polls === 1);

    scheduler.handle({ id: "c1", kind: RUNNER_COMMAND_KIND.standingPause, taskId: PR_TASK.id, requestedBy: "Dana" });
    later(scheduler);
    later(scheduler);
    expect(polls).toBe(1);
    expect(scheduler.report()[0]).toMatchObject({ status: "paused", nextCheckAt: undefined });

    scheduler.handle({ id: "c2", kind: RUNNER_COMMAND_KIND.standingResume, taskId: PR_TASK.id, requestedBy: "Dana" });
    await until(() => polls === 2);
    scheduler.handle({ id: "c3", kind: RUNNER_COMMAND_KIND.standingCheckNow, taskId: PR_TASK.id, requestedBy: "Dana" });
    await until(() => polls === 3);

    scheduler.handle({ id: "c4", kind: RUNNER_COMMAND_KIND.standingRemove, taskId: PR_TASK.id, requestedBy: "Dana" });
    expect(scheduler.report()).toEqual([]);
  });

  it("stops a run in flight when its task is removed", async () => {
    const pool = makePool();
    const scheduler = makeScheduler(pool, {}, createMockStandingRunners({ stepMs: 40, minPollIntervalMs: 0 }));
    set(scheduler, PR_TASK);
    await until(() => polls === 1);
    listing = [pull(60)];
    later(scheduler);
    await until(() => pool.report()[0]?.standing !== undefined);
    scheduler.handle({ id: "c-rm", kind: RUNNER_COMMAND_KIND.standingRemove, taskId: PR_TASK.id, requestedBy: "Dana" });
    await until(() => pool.report()[0]?.standing === undefined);
    expect(runs(scheduler.pendingEvents())).toEqual([]);
  });
});

describe("a restarted runner", () => {
  it("keeps its tasks, their ledgers and today's spend, and does not review a pull request twice", async () => {
    const first = makeScheduler(makePool());
    set(first, PR_TASK);
    await until(() => polls === 1);
    listing = [pull(70)];
    later(first);
    await until(() => runs(first.pendingEvents()).length === 1);

    ledger = new SpendLedger({ budgetUsd: undefined, now: () => new Date(clock) });
    const second = makeScheduler(makePool());
    second.start();
    second.stop();
    expect(second.report()[0]).toMatchObject({ id: PR_TASK.id, handledToday: 1, recent: [{ outcome: "simulated", pr: 70 }] });
    expect(second.spentTodayUsd()).toBeCloseTo(MOCK_STANDING_STEP_USD * 4);
    // Its day is booked in the runner's ledger again.
    expect(ledger.report().spentUsd).toBeCloseTo(MOCK_STANDING_STEP_USD * 4);
    later(second);
    await until(() => polls >= 2);
    later(second);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runs(second.pendingEvents())).toEqual([]);
  });

  it("tries a run the restart cut short again", async () => {
    const pool = makePool();
    const first = makeScheduler(pool, {}, createMockStandingRunners({ stepMs: 1000, minPollIntervalMs: 0 }));
    set(first, PR_TASK);
    await until(() => polls === 1);
    listing = [pull(80)];
    later(first);
    await until(() => pool.report()[0]?.standing !== undefined);
    // Killed mid-run: the next runner finds it saved as running.
    const second = makeScheduler(makePool());
    second.tick();
    await until(() => runs(second.pendingEvents()).length === 1);
    expect(runs(second.pendingEvents())).toEqual([["simulated", 80]]);
    pool.stopAll();
  });

  it("waits, as the runner shuts down, for a run under way to end", async () => {
    const pool = makePool();
    const scheduler = makeScheduler(pool, {}, createMockStandingRunners({ stepMs: 1000, minPollIntervalMs: 0 }));
    set(scheduler, PR_TASK);
    await until(() => polls === 1);
    listing = [pull(80)];
    later(scheduler);
    await until(() => pool.report()[0]?.standing !== undefined);
    let stopped = false;
    const stopping = scheduler.stop().then(() => (stopped = true));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stopped).toBe(false);

    void pool.stopAll();
    await stopping;
    expect(stopped).toBe(true);
  });
});

describe("a schedule", () => {
  it("fires at each minute its cron names, on a free slot, and misses one it cannot start", async () => {
    const scheduler = makeScheduler(makePool());
    set(scheduler, SCHEDULE_TASK);
    expect(scheduler.report()[0]).toMatchObject({ trigger: "weekdays 09:00", nextCheckAt: new Date(2026, 9, 19, 9, 0).getTime() });
    clock = new Date(2026, 9, 19, 9, 0, 5).getTime();
    scheduler.tick();
    await until(() => runs(scheduler.pendingEvents()).length === 1);
    const event = scheduler.pendingEvents()[0];
    expect(event).toMatchObject({ kind: "standing-run", outcome: "simulated", pr: undefined, message: expect.stringContaining("Summarise what changed.") });
    expect(scheduler.report()[0]?.nextCheckAt).toBe(new Date(2026, 9, 20, 9, 0).getTime());

    // Run now, from the roster's button.
    scheduler.handle({ id: "c-now", kind: RUNNER_COMMAND_KIND.standingCheckNow, taskId: SCHEDULE_TASK.id, requestedBy: "Dana" });
    await until(() => runs(scheduler.pendingEvents()).length === 2);
  });

  it("is held to the standing budget, which it says once", async () => {
    const scheduler = makeScheduler(makePool(), { budgetUsd: 0.1 });
    set(scheduler, SCHEDULE_TASK);
    scheduler.handle({ id: "c-now", kind: RUNNER_COMMAND_KIND.standingCheckNow, taskId: SCHEDULE_TASK.id, requestedBy: "Dana" });
    await until(() => runs(scheduler.pendingEvents()).length === 1);
    scheduler.handle({ id: "c-now2", kind: RUNNER_COMMAND_KIND.standingCheckNow, taskId: SCHEDULE_TASK.id, requestedBy: "Dana" });
    scheduler.handle({ id: "c-now3", kind: RUNNER_COMMAND_KIND.standingCheckNow, taskId: SCHEDULE_TASK.id, requestedBy: "Dana" });
    expect(scheduler.report()[0]).toMatchObject({ status: "over-budget", dailyUsd: 0.1 });
    expect(runs(scheduler.pendingEvents()).map(([outcome]) => outcome)).toEqual(["simulated"]);
  });

  it("caps a run of a task with no dollars of its own at what is left of the standing budget, and not at all without one", async () => {
    for (const [budgetUsd, expected] of [
      [2, [undefined, undefined, 2, 1.25]],
      [undefined, [undefined, undefined, undefined, undefined]],
    ] as const) {
      const seen: Array<number | undefined> = [];
      const runners: StandingRunners = {
        ...createMockStandingRunners({ stepMs: 2, minPollIntervalMs: 0 }),
        schedule: async (job) => {
          seen.push(job.spec.caps.perRunUsd);
          return { outcome: "simulated", costUsd: 0.75, message: "Done." };
        },
      };
      const scheduler = makeScheduler(makePool(), { budgetUsd }, runners);
      set(scheduler, SCHEDULE_TASK);
      for (const n of [1, 2]) {
        scheduler.handle({ id: `c-now${n}`, kind: RUNNER_COMMAND_KIND.standingCheckNow, taskId: SCHEDULE_TASK.id, requestedBy: "Dana" });
        await until(() => runs(scheduler.pendingEvents()).length === n);
      }
      expect([SCHEDULE_TASK.caps.perRunUsd, new StandingStore({ file: join(dir, "standing.json") }).load("").tasks[0]?.spec.caps.perRunUsd, ...seen]).toEqual(expected);
      rmSync(join(dir, "standing.json"), { force: true });
    }
  });
});

describe("a pull request steward", () => {
  /** Waits for the steward's look under way, its pull requests' states read, to end. */
  async function looked(scheduler: StandingScheduler): Promise<void> {
    await until(() => scheduler.report()[0]?.lastCheckAt === clock);
  }

  /** Moves the clock on past the interval and waits for that look to end. */
  async function look(scheduler: StandingScheduler): Promise<void> {
    later(scheduler);
    await looked(scheduler);
  }

  it("reviews a new pull request, says once why it is not merged, and merges it once its checks are green", async () => {
    const states = new Map([[41, pullState("aaaa111", { checks: [{ name: "ci", state: "fail", required: true }] })]]);
    const steward = stewardRunners(states);
    const scheduler = makeScheduler(makePool(), {}, steward.runners);
    listing = [pull(40)];
    set(scheduler, STEWARD_TASK);
    await looked(scheduler);

    listing = [pull(40), pull(41)];
    await look(scheduler);
    await until(() => runs(scheduler.pendingEvents()).length === 1);
    expect(runs(scheduler.pendingEvents())).toEqual([["simulated", 41]]);

    await look(scheduler);
    expect(scheduler.pendingEvents().at(-1)).toMatchObject({ outcome: "skipped", pr: { number: 41 }, message: "It is not merged yet: the check “ci” failed." });
    // Said once a head.
    await look(scheduler);
    expect(runs(scheduler.pendingEvents())).toHaveLength(2);
    expect(steward.merged).toEqual([]);

    states.set(41, pullState("aaaa111"));
    await look(scheduler);
    await until(() => runs(scheduler.pendingEvents()).length === 3);
    expect(steward.merged).toEqual([[41, "aaaa111"]]);
    expect(runs(scheduler.pendingEvents()).at(-1)).toEqual(["merged", 41]);
    // The pull request open when it was set up is never looked at, let alone merged.
    expect(steward.merged.some(([number]) => number === 40)).toBe(false);
  });

  it("merges nothing while a check runs or with none at all, and resolves conflicts at a head before merging the next", async () => {
    const states = new Map([[42, pullState("bbbb222", { checks: [{ name: "ci", state: "pending", required: true }] })]]);
    const steward = stewardRunners(states);
    const scheduler = makeScheduler(makePool(), {}, steward.runners);
    set(scheduler, STEWARD_TASK);
    await looked(scheduler);
    listing = [pull(42)];
    await look(scheduler);
    await until(() => runs(scheduler.pendingEvents()).length === 1);
    await look(scheduler);
    // Still running: nothing said, nothing merged.
    expect(runs(scheduler.pendingEvents())).toHaveLength(1);

    states.set(42, pullState("bbbb222", { mergeable: "CONFLICTING", mergeState: "DIRTY" }));
    await look(scheduler);
    await until(() => runs(scheduler.pendingEvents()).length === 2);
    expect(runs(scheduler.pendingEvents()).at(-1)).toEqual(["resolved", 42]);

    // The push is a new head, with no checks yet: never merged on none.
    states.set(42, pullState("cccc333", { checks: [] }));
    await look(scheduler);
    expect(scheduler.pendingEvents().at(-1)).toMatchObject({ outcome: "skipped", message: "It is not merged yet: it has no checks." });
    states.set(42, pullState("cccc333"));
    await look(scheduler);
    await until(() => steward.merged.length === 1);
    expect(steward.merged).toEqual([[42, "cccc333"]]);
    expect(steward.resolved).toEqual([42]);
  });

  it("tries a resolve that failed for good again only once its head or its base moves", async () => {
    const states = new Map([[44, pullState("eeee555", { mergeable: "CONFLICTING", mergeState: "DIRTY" })]]);
    const steward = stewardRunners(states);
    const resolved: number[] = [];
    const runners: StandingRunners = {
      ...steward.runners,
      resolve: async (job) => {
        resolved.push(job.pr?.number ?? 0);
        return { outcome: "failed", costUsd: 0, message: "Nothing was pushed: it had all 3 passes.", final: true };
      },
    };
    const scheduler = makeScheduler(makePool(), {}, runners);
    set(scheduler, STEWARD_TASK);
    await looked(scheduler);
    listing = [pull(44)];
    await look(scheduler);
    await until(() => runs(scheduler.pendingEvents()).length === 1);
    await look(scheduler);
    await until(() => resolved.length === 1);
    expect(scheduler.pendingEvents().at(-1)).toMatchObject({ outcome: "failed", final: true });
    // Past every retry's backoff: still not tried again.
    for (let looks = 0; looks < 5; looks += 1) {
      await look(scheduler);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resolved).toEqual([44]);

    states.set(44, pullState("eeee555", { mergeable: "CONFLICTING", mergeState: "DIRTY", baseSha: "base111" }));
    await look(scheduler);
    await until(() => resolved.length === 2);
    states.set(44, pullState("ffff666", { mergeable: "CONFLICTING", mergeState: "DIRTY", baseSha: "base111" }));
    await look(scheduler);
    await until(() => resolved.length === 3);
  });

  it("never touches an outside contributor's pull request", async () => {
    const states = new Map([[43, pullState("dddd444")]]);
    const steward = stewardRunners(states);
    const scheduler = makeScheduler(makePool(), {}, steward.runners);
    set(scheduler, STEWARD_TASK);
    await looked(scheduler);
    listing = [pull(43, { association: "CONTRIBUTOR", author: "stranger" })];
    await look(scheduler);
    await look(scheduler);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runs(scheduler.pendingEvents())).toEqual([["skipped", 43]]);
    expect(steward.merged).toEqual([]);
  });

  it("is the office's one pull request watcher", () => {
    const scheduler = makeScheduler(makePool());
    set(scheduler, PR_TASK);
    set(scheduler, STEWARD_TASK);
    expect(scheduler.report().map((task) => task.id)).toEqual([PR_TASK.id]);
    expect(scheduler.pendingEvents()).toEqual([expect.objectContaining({ kind: "standing-refused", taskId: STEWARD_TASK.id })]);
  });
});

describe("a task with an agent hired for it", () => {
  it("runs on that agent's slot alone, which no other task takes, and goes when the agent is fired", async () => {
    const pool = makePool();
    const scheduler = makeScheduler(pool, { maxConcurrent: 2 });
    set(scheduler, { ...SCHEDULE_TASK, agent: "slot-2" });
    set(scheduler, { ...SCHEDULE_TASK, id: "st-evening1", name: "Evening summary" });
    expect(scheduler.report()[0]).toMatchObject({ agent: "slot-2" });
    scheduler.handle({ id: "c-a", kind: RUNNER_COMMAND_KIND.standingCheckNow, taskId: SCHEDULE_TASK.id, requestedBy: "Dana" });
    scheduler.handle({ id: "c-b", kind: RUNNER_COMMAND_KIND.standingCheckNow, taskId: "st-evening1", requestedBy: "Dana" });
    await until(() => runs(scheduler.pendingEvents()).length === 2);
    const bySlot = Object.fromEntries(
      scheduler.pendingEvents().flatMap((event) => (event.kind === "standing-run" ? [[event.taskId, event.slotId]] : [])),
    );
    expect(bySlot).toEqual({ [SCHEDULE_TASK.id]: "slot-2", "st-evening1": "slot-1" });

    pool.handle({ id: "c-fire", slotId: "slot-2", kind: RUNNER_COMMAND_KIND.fire, requestedBy: "Dana" });
    scheduler.tick();
    expect(scheduler.report().map((task) => task.id)).toEqual(["st-evening1"]);
  });

  it("is refused when its agent is not on the runner", () => {
    const scheduler = makeScheduler(makePool());
    set(scheduler, { ...SCHEDULE_TASK, agent: "hired-nobody" });
    expect(scheduler.report()).toEqual([]);
    expect(scheduler.pendingEvents()).toEqual([expect.objectContaining({ kind: "standing-refused", message: expect.stringContaining("hired-nobody") })]);
  });
});

describe("a new schedule", () => {
  it("changes how often a task runs, as a new version, and is refused for a kind that does not take it", () => {
    const scheduler = makeScheduler(makePool());
    set(scheduler, SCHEDULE_TASK);
    set(scheduler, STEWARD_TASK);
    scheduler.handle({ id: "c-r1", kind: RUNNER_COMMAND_KIND.standingReschedule, taskId: SCHEDULE_TASK.id, schedule: { cron: "30 17 * * *" }, requestedBy: "Dana" });
    scheduler.handle({ id: "c-r2", kind: RUNNER_COMMAND_KIND.standingReschedule, taskId: STEWARD_TASK.id, schedule: { intervalSeconds: 600 }, requestedBy: "Dana" });
    const [schedule, steward] = scheduler.report();
    expect(schedule).toMatchObject({ schedule: { cron: "30 17 * * *" }, trigger: "daily 17:30", nextCheckAt: new Date(2026, 9, 19, 17, 30).getTime() });
    expect(steward).toMatchObject({ schedule: { intervalSeconds: 600 }, trigger: "every 10 min" });

    scheduler.handle({ id: "c-r3", kind: RUNNER_COMMAND_KIND.standingReschedule, taskId: SCHEDULE_TASK.id, schedule: { intervalSeconds: 600 }, requestedBy: "Dana" });
    expect(scheduler.report()[0]?.schedule).toEqual({ cron: "30 17 * * *" });
    expect(scheduler.pendingEvents().at(-1)).toMatchObject({ kind: "standing-refused", taskId: SCHEDULE_TASK.id });
  });
});

describe("a new agent for a task", () => {
  it("runs the task on that slot alone, as a new version, and is refused for a slot the runner lacks", () => {
    const pool = makePool();
    const scheduler = makeScheduler(pool);
    set(scheduler, STEWARD_TASK);
    const [slot] = pool.freeForStanding();
    scheduler.handle({ id: "c-a1", kind: RUNNER_COMMAND_KIND.standingAssign, taskId: STEWARD_TASK.id, agent: slot ?? "", requestedBy: "Dana" });
    expect(scheduler.report()[0]?.agent).toBe(slot);

    scheduler.handle({ id: "c-a2", kind: RUNNER_COMMAND_KIND.standingAssign, taskId: STEWARD_TASK.id, agent: "hired-nobody", requestedBy: "Dana" });
    // Kept on the slot it had: a slot the runner lacks would have the tick drop the task.
    expect(scheduler.report()[0]?.agent).toBe(slot);
    expect(scheduler.pendingEvents().at(-1)).toMatchObject({ kind: "standing-refused", taskId: STEWARD_TASK.id, message: expect.stringContaining("hired-nobody") });
  });
});

describe("a run's record", () => {
  it("keeps its summary, result and screen as plain text until a sync delivers it, across a restart", async () => {
    const scheduler = makeScheduler(makePool());
    set(scheduler, SCHEDULE_TASK);
    scheduler.handle({ id: "c-now", kind: RUNNER_COMMAND_KIND.standingCheckNow, taskId: SCHEDULE_TASK.id, requestedBy: "Dana" });
    await until(() => scheduler.pendingRuns().length === 1);
    const [record] = scheduler.pendingRuns();
    expect(record).toMatchObject({
      taskId: SCHEDULE_TASK.id,
      outcome: "simulated",
      agent: expect.any(String),
      summary: "Simulated run of “Morning summary”: nothing was posted or done",
      result: expect.stringContaining("Summarise what changed."),
    });
    expect(record?.log).toContain("● Reading the instruction");
    expect(record?.log).not.toContain("\u001b");
    expect(record?.id).not.toBe(scheduler.pendingEvents()[0]?.id);

    const again = makeScheduler(makePool());
    expect(again.pendingRuns()).toEqual([record]);
    again.delivered(new Set([record?.id ?? ""]));
    expect(again.pendingRuns()).toEqual([]);
    expect(makeScheduler(makePool()).pendingRuns()).toEqual([]);
  });
});
