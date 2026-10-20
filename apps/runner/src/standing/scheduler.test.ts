/**
 * The standing tasks' scheduler, with the mock's scripted runs on a real slot
 * pool: what a task's first look leaves alone, what it reviews once, what it
 * skips, how issue work takes a slot back, how the caps hold, what a restart
 * keeps, and when a schedule fires.
 *
 * The clock the scheduler reads is the test's, and each look is a `tick` the
 * test calls; the mock's steps run on real, very short timers.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_STANDING_CAPS,
  RUNNER_COMMAND_KIND,
  type RunnerEvent,
  type RunnerSlotCommand,
  type RunnerStandingRunEvent,
  STANDING_OFF,
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

  it("starts nothing more today once its daily spend is used up, and shows it", async () => {
    const scheduler = makeScheduler(makePool());
    set(scheduler, { ...PR_TASK, caps: { ...DEFAULT_STANDING_CAPS, dailyUsd: 0.15 } });
    await until(() => polls === 1);
    listing = [pull(40), pull(41)];
    later(scheduler);
    await until(() => runs(scheduler.pendingEvents()).length === 1);
    scheduler.tick();
    expect(scheduler.report()[0]).toMatchObject({ status: "over-budget", queued: 1, nextCheckAt: undefined });
    expect(runs(scheduler.pendingEvents())).toEqual([["simulated", 40]]);

    // A new day: it carries on.
    clock = new Date(2026, 9, 20, 8, 0).getTime();
    scheduler.tick();
    await until(() => runs(scheduler.pendingEvents()).length === 2);
    expect(runs(scheduler.pendingEvents())[1]).toEqual(["simulated", 41]);
  });

  it("starts nothing more that day once it reaches its runs an hour", async () => {
    const scheduler = makeScheduler(makePool());
    set(scheduler, { ...PR_TASK, caps: { ...DEFAULT_STANDING_CAPS, maxRunsPerHour: 1 } });
    await until(() => polls === 1);
    listing = [pull(50), pull(51)];
    later(scheduler);
    await until(() => runs(scheduler.pendingEvents()).length === 1);
    clock += 2 * 60 * 60_000;
    scheduler.tick();
    expect(scheduler.report()[0]?.status).toBe("over-budget");
  });

  it("is refused by a real agent's runner with no standing budget, which says why", () => {
    const scheduler = makeScheduler(makePool(), { off: STANDING_OFF.noBudget });
    set(scheduler, PR_TASK);
    expect(scheduler.report()).toEqual([]);
    expect(scheduler.off()).toBe("no-budget");
    expect(scheduler.pendingEvents()).toEqual([
      expect.objectContaining({ kind: "standing-refused", taskId: PR_TASK.id, message: expect.stringContaining("RUNNER_STANDING_DAILY_BUDGET_USD") }),
    ]);
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

  it("polls and runs nothing a mock left in standing.json once it is a real agent's runner with no standing budget", async () => {
    const first = makeScheduler(makePool());
    set(first, PR_TASK);
    set(first, SCHEDULE_TASK);
    await until(() => polls === 1);
    first.stop();

    const pool = makePool();
    const second = makeScheduler(pool, { off: STANDING_OFF.noBudget });
    listing = [pull(90)];
    later(second);
    second.handle({ id: "c-now", kind: RUNNER_COMMAND_KIND.standingCheckNow, taskId: PR_TASK.id, requestedBy: "Dana" });
    second.handle({ id: "c-fire", kind: RUNNER_COMMAND_KIND.standingCheckNow, taskId: SCHEDULE_TASK.id, requestedBy: "Dana" });
    clock = new Date(2026, 9, 19, 9, 0).getTime();
    second.tick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(polls).toBe(1);
    expect(pool.report().every((slot) => slot.standing === undefined)).toBe(true);
    expect(runs(second.pendingEvents())).toEqual([]);
    for (const task of second.report()) {
      expect(task).toMatchObject({ status: "error", nextCheckAt: undefined, queued: 0, lastError: expect.stringContaining("RUNNER_STANDING_DAILY_BUDGET_USD") });
    }
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
    // The caps were held to the standing budget, so the task's own day is spent first.
    expect(scheduler.report()[0]?.status).toBe("over-budget");
    expect(runs(scheduler.pendingEvents()).map(([outcome]) => outcome)).toEqual(["simulated"]);
  });
});
