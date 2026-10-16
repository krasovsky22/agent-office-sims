/**
 * The slot pool with the `mock` agent: a start runs its script to `started`
 * and an outcome and leaves the slot idle again, a stop or the task timeout
 * cuts it short, and everything reported fits the contract's budgets.
 *
 * Fake timers drive the mock's script, so each step is a step of the clock.
 */

import { MAX_NAME_LENGTH, MAX_TITLE_LENGTH, type RunnerCommand } from "@sim/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockAgent } from "./agents/mock.js";
import type { Agent } from "./agents/types.js";
import { SlotPool, fitBytes } from "./slots.js";

const REPO = "krasovsky22/agent-office-sims";
const STEP_MS = 100;
const TIMEOUT_MS = 60_000;

const START: RunnerCommand = {
  id: "command-1",
  slotId: "slot-1",
  kind: "start",
  issueNumber: 39,
  title: "Night shift",
  url: `https://github.com/${REPO}/issues/39`,
  note: "",
  requestedBy: "Dana",
};

function pool(outcome: "failed" | "pr-opened" = "failed", agent?: Agent) {
  let nextId = 1;
  return new SlotPool({
    count: 2,
    agent: agent ?? createMockAgent({ outcome, repo: REPO, stepMs: STEP_MS }),
    taskTimeoutMs: TIMEOUT_MS,
    eventId: () => `event-${nextId++}`,
  });
}

function slot(slots: SlotPool, id = "slot-1") {
  return slots.report().find((candidate) => candidate.id === id);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SlotPool", () => {
  it("starts with every slot idle and named after its agent", () => {
    expect(pool().report()).toEqual([
      { id: "slot-1", name: "Mock 1", status: "idle", issueNumber: undefined, activity: "", pr: undefined },
      { id: "slot-2", name: "Mock 2", status: "idle", issueNumber: undefined, activity: "", pr: undefined },
    ]);
  });

  it("runs a start to started, through its script, to failed, and back to idle", () => {
    const slots = pool();
    slots.handle(START);
    expect(slot(slots)).toMatchObject({ status: "starting", issueNumber: 39, activity: "Starting" });
    expect(slot(slots, "slot-2")?.status).toBe("idle");

    vi.advanceTimersByTime(STEP_MS);
    expect(slot(slots)).toMatchObject({ status: "working", issueNumber: 39, activity: "Reading issue #39" });
    expect(slots.pendingEvents()).toEqual([
      { id: "event-1", kind: "started", slotId: "slot-1", issueNumber: 39, pr: undefined, message: "" },
    ]);

    vi.advanceTimersByTime(STEP_MS * 3);
    expect(slot(slots)).toMatchObject({ status: "working", activity: "Bash: pnpm test" });

    vi.advanceTimersByTime(STEP_MS);
    expect(slot(slots)).toMatchObject({ status: "idle", issueNumber: undefined, activity: "" });
    expect(slots.pendingEvents().map((event) => event.kind)).toEqual(["started", "failed"]);
    expect(slots.pendingEvents()[1]?.message).toMatch(/always fails/);
  });

  it("opens a fake pull request when the mock is configured to", () => {
    const slots = pool("pr-opened");
    slots.handle(START);
    vi.advanceTimersByTime(STEP_MS * 5);
    expect(slot(slots)?.status).toBe("idle");
    expect(slots.pendingEvents()[1]).toEqual({
      id: "event-2",
      kind: "pr-opened",
      slotId: "slot-1",
      issueNumber: 39,
      pr: { number: 1_000_039, title: "[mock] Night shift", url: `https://github.com/${REPO}/pull/1000039` },
      message: "",
    });
  });

  it("honours stop: the script goes no further, and the work is reported failed with the reason", () => {
    const slots = pool("pr-opened");
    slots.handle(START);
    vi.advanceTimersByTime(STEP_MS * 2);
    slots.handle({ id: "command-2", slotId: "slot-1", kind: "stop", reason: "CEO changed their mind" });
    expect(slot(slots)?.status).toBe("idle");
    vi.advanceTimersByTime(STEP_MS * 10);
    expect(slots.pendingEvents().map((event) => [event.kind, event.message])).toEqual([
      ["started", ""],
      ["failed", "Stopped: CEO changed their mind"],
    ]);
  });

  it("ignores a stop for an idle slot", () => {
    const slots = pool();
    slots.handle({ id: "command-2", slotId: "slot-1", kind: "stop", reason: "" });
    expect(slots.pendingEvents()).toEqual([]);
  });

  it("refuses a start on a busy slot without disturbing its work", () => {
    const slots = pool();
    slots.handle(START);
    slots.handle({ ...START, id: "command-2", issueNumber: 40 });
    expect(slot(slots)?.issueNumber).toBe(39);
    expect(slots.pendingEvents()).toEqual([
      { id: "event-1", kind: "failed", slotId: "slot-1", issueNumber: 40, pr: undefined, message: "Mock 1 is busy with #39" },
    ]);
  });

  it("stops work that runs past the task timeout", () => {
    const stalled: Agent = { label: "Stuck", start: () => ({ stop: vi.fn() }) };
    const slots = pool("failed", stalled);
    slots.handle(START);
    vi.advanceTimersByTime(TIMEOUT_MS);
    expect(slot(slots)?.status).toBe("idle");
    expect(slots.pendingEvents()[0]).toMatchObject({ kind: "failed", message: "Timed out after 1 minute" });
  });

  it("stops every run as the runner shuts down", () => {
    const slots = pool();
    slots.handle(START);
    slots.handle({ ...START, id: "command-2", slotId: "slot-2", issueNumber: 40 });
    slots.stopAll();
    expect(slots.report().every((report) => report.status === "idle")).toBe(true);
    expect(slots.pendingEvents().map((event) => [event.slotId, event.message])).toEqual([
      ["slot-1", "Stopped: the runner shut down"],
      ["slot-2", "Stopped: the runner shut down"],
    ]);
  });

  it("ignores a command for a slot it does not have, and a prompt", () => {
    const slots = pool();
    slots.handle({ ...START, slotId: "slot-9" });
    slots.handle({ id: "command-2", slotId: "slot-1", kind: "prompt", text: "hurry", requestedBy: "Dana" });
    expect(slots.report().every((report) => report.status === "idle")).toBe(true);
    expect(slots.pendingEvents()).toEqual([]);
  });

  it("forgets only the events a sync delivered", () => {
    const slots = pool();
    slots.handle(START);
    vi.advanceTimersByTime(STEP_MS * 5);
    slots.delivered(new Set(["event-1"]));
    expect(slots.pendingEvents().map((event) => event.id)).toEqual(["event-2"]);
  });

  it("cuts what an agent says to the contract's budgets", () => {
    const chatty: Agent = {
      label: "A label far too long for a name",
      start: (_task, reporter) => {
        reporter.started();
        reporter.progress("é".repeat(200));
        return { stop: () => undefined };
      },
    };
    const slots = pool("failed", chatty);
    slots.handle(START);
    const [report] = slots.report();
    expect(Buffer.byteLength(report?.name ?? "")).toBeLessThanOrEqual(MAX_NAME_LENGTH);
    expect(Buffer.byteLength(report?.activity ?? "")).toBe(MAX_TITLE_LENGTH);
  });

  it("reports nothing an agent says once its work has ended", () => {
    let late: (() => void) | undefined;
    const agent: Agent = {
      label: "Late",
      start: (_task, reporter) => {
        late = () => {
          reporter.started();
          reporter.progress("still here");
          reporter.failed("too late");
        };
        return { stop: () => undefined };
      },
    };
    const slots = pool("failed", agent);
    slots.handle(START);
    slots.handle({ id: "command-2", slotId: "slot-1", kind: "stop", reason: "" });
    late?.();
    expect(slot(slots)?.status).toBe("idle");
    expect(slots.pendingEvents()).toHaveLength(1);
  });
});

describe("fitBytes", () => {
  it("measures as a sync body does, escapes included, and cuts whole characters", () => {
    expect(fitBytes("plain", 5)).toBe("plain");
    expect(fitBytes("plain", 4)).toBe("plai");
    expect(fitBytes('a"b', 3)).toBe('a"');
    expect(fitBytes('a"b', 2)).toBe("a");
    expect(fitBytes("😀😀", 6)).toBe("😀");
  });

  it("cuts a very long input to the budget quickly", () => {
    const started = Date.now();
    const cut = fitBytes(`${"é".repeat(500_000)}"`, 1001);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(cut).toBe("é".repeat(500));
  });
});
