/**
 * The slot pool with the `mock` agent: a start opens the task's workspace,
 * runs its script to `started` and an outcome there, closes the workspace and
 * leaves the slot idle again, a stop or the task timeout cuts it short, and
 * everything reported fits the contract's budgets.
 *
 * Fake timers drive the mock's script, so each step is a step of the clock.
 * The workspace is a plain git checkout the mock commits in; real worktrees
 * are `./slotWorktrees.test.ts`'s.
 */

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { MAX_NAME_LENGTH, MAX_TITLE_LENGTH, type RunnerCommand } from "@sim/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MOCK_NEEDS_INPUT_STEPS, createMockAgent } from "./agents/mock.js";
import type { Agent, AgentReporter, AgentTask } from "./agents/types.js";
import { type GitFixture, gitFixture } from "./gitFixture.js";
import { createRedactor } from "./redact.js";
import { type SlotWorkspaces, SlotPool, TURN_DONE, fitBytes } from "./slots.js";

const REPO = "krasovsky22/agent-office-sims";
const STEP_MS = 100;
const TIMEOUT_MS = 60_000;
/** The mock's whole script, from the start command to its outcome. */
const SCRIPT_MS = STEP_MS * (5 + MOCK_NEEDS_INPUT_STEPS);

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

let fixture: GitFixture;
/** What the pool asked of its workspaces, in order. */
let asked: string[];

/** Every task works in the fixture's checkout; `fail` refuses to open one. */
function workspaces(fail?: string): SlotWorkspaces {
  return {
    open: async (slotId, issueNumber) => {
      asked.push(`open ${slotId} #${issueNumber}`);
      if (fail !== undefined) {
        throw new Error(fail);
      }
      return fixture.developer;
    },
    close: async (slotId, issueNumber) => {
      asked.push(`close ${slotId} #${issueNumber}`);
    },
  };
}

function pool(outcome: "failed" | "pr-opened" = "failed", agent?: Agent, spaces = workspaces()) {
  let nextId = 1;
  return new SlotPool({
    count: 2,
    agent: agent ?? createMockAgent({ outcome, repo: REPO, stepMs: STEP_MS }),
    workspaces: spaces,
    taskTimeoutMs: TIMEOUT_MS,
    eventId: () => `event-${nextId++}`,
  });
}

/** Lets an opened workspace reach the agent waiting on it. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function slot(slots: SlotPool, id = "slot-1") {
  return slots.report().find((candidate) => candidate.id === id);
}

describe("SlotPool", () => {
  beforeEach(() => {
    fixture = gitFixture();
    asked = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    fixture.cleanup();
  });

  it("starts with every slot idle and named after its agent", () => {
    expect(pool().report()).toEqual([
      { id: "slot-1", name: "Mock 1", status: "idle", issueNumber: undefined, activity: "", pr: undefined },
      { id: "slot-2", name: "Mock 2", status: "idle", issueNumber: undefined, activity: "", pr: undefined },
    ]);
  });

  it("runs a start to started, through its script, to failed, and back to idle", async () => {
    const slots = pool();
    slots.handle(START);
    expect(slot(slots)).toMatchObject({ status: "starting", issueNumber: 39, activity: "Making a worktree" });
    expect(slot(slots, "slot-2")?.status).toBe("idle");
    await settle();
    expect(slot(slots)).toMatchObject({ status: "starting", activity: "Starting" });

    await vi.advanceTimersByTimeAsync(STEP_MS);
    expect(slot(slots)).toMatchObject({ status: "working", issueNumber: 39, activity: "Reading issue #39" });
    expect(slots.pendingEvents()).toEqual([
      { id: "event-1", kind: "started", slotId: "slot-1", issueNumber: 39, pr: undefined, message: "" },
    ]);

    await vi.advanceTimersByTimeAsync(STEP_MS * 2);
    expect(slot(slots)).toMatchObject({ status: "working", activity: "Bash: git commit" });

    // It waits on a person, still holding its issue, then carries on.
    await vi.advanceTimersByTimeAsync(STEP_MS);
    expect(slot(slots)).toMatchObject({ status: "needs-input", issueNumber: 39, activity: "Permission: Bash pnpm test" });
    await vi.advanceTimersByTimeAsync(STEP_MS * (MOCK_NEEDS_INPUT_STEPS - 1));
    expect(slot(slots)?.status).toBe("needs-input");
    await vi.advanceTimersByTimeAsync(STEP_MS);
    expect(slot(slots)).toMatchObject({ status: "working", activity: "Bash: pnpm test" });

    await vi.advanceTimersByTimeAsync(STEP_MS);
    expect(slot(slots)).toMatchObject({ status: "idle", issueNumber: undefined, activity: "" });
    expect(slots.pendingEvents().map((event) => event.kind)).toEqual(["started", "failed"]);
    expect(slots.pendingEvents()[1]?.message).toMatch(/always fails/);
    // It worked in its workspace, and gave it up once done.
    expect(fixture.git(fixture.developer, "log", "-1", "--format=%s")).toBe("mock: work on #39");
    expect(asked).toEqual(["open slot-1 #39", "close slot-1 #39"]);
  });

  it("commits again when its work is already there, as in a worktree picked up again", async () => {
    const slots = pool();
    for (const id of ["command-1", "command-2"]) {
      slots.handle({ ...START, id });
      await vi.advanceTimersByTimeAsync(SCRIPT_MS);
    }
    expect(slots.pendingEvents().map((event) => event.message)).toEqual([
      "",
      expect.stringMatching(/always fails/),
      "",
      expect.stringMatching(/always fails/),
    ]);
    expect(fixture.git(fixture.developer, "log", "-2", "--format=%s").split("\n")).toEqual([
      "mock: work on #39",
      "mock: work on #39",
    ]);
  });

  it("fails the work, saying what git said, when its commit fails", async () => {
    // Not a repository any more: the commit has nowhere to go.
    rmSync(join(fixture.developer, ".git"), { recursive: true });
    const slots = pool();
    slots.handle(START);
    await vi.advanceTimersByTimeAsync(STEP_MS * 3);
    expect(slots.pendingEvents()[1]?.message).toMatch(/^Bash: git commit failed: fatal: not a git repository/);
  });

  it("never commits in a repository above its workspace", async () => {
    // A workspace that lost its own repository, inside someone else's.
    const workdir = join(fixture.developer, "kept");
    mkdirSync(workdir);
    const head = fixture.git(fixture.developer, "rev-parse", "HEAD");
    const slots = pool("failed", undefined, { open: async () => workdir, close: async () => undefined });
    slots.handle(START);
    await vi.advanceTimersByTimeAsync(STEP_MS * 3);
    expect(slots.pendingEvents()[1]?.message).toMatch(/^Bash: git commit failed: fatal: not a git repository/);
    expect(fixture.git(fixture.developer, "rev-parse", "HEAD")).toBe(head);
    expect(fixture.git(fixture.developer, "status", "--porcelain")).toBe("?? kept/");
  });

  it("hands the agent its workspace as its working directory", async () => {
    const tasks: AgentTask[] = [];
    const spy: Agent = {
      label: "Spy",
      start: (task) => {
        tasks.push(task);
        return { stop: () => undefined };
      },
    };
    const slots = pool("failed", spy);
    slots.handle({ ...START, note: "please" });
    await settle();
    expect(tasks).toEqual([
      {
        issueNumber: 39,
        title: "Night shift",
        url: `https://github.com/${REPO}/issues/39`,
        note: "please",
        requestedBy: "Dana",
        workdir: fixture.developer,
      },
    ]);
  });

  it("fails the work, saying why, when its workspace cannot be opened", async () => {
    const start = vi.fn();
    const slots = pool("failed", { label: "Spy", start }, workspaces("disk full"));
    slots.handle(START);
    await settle();
    expect(start).not.toHaveBeenCalled();
    expect(slot(slots)?.status).toBe("idle");
    expect(slots.pendingEvents()).toEqual([
      { id: "event-1", kind: "failed", slotId: "slot-1", issueNumber: 39, pr: undefined, message: "No worktree: disk full" },
    ]);
    expect(asked).toEqual(["open slot-1 #39", "close slot-1 #39"]);
  });

  it("starts no agent for work stopped while its workspace was opening", async () => {
    const start = vi.fn();
    const slots = pool("failed", { label: "Spy", start });
    slots.handle(START);
    slots.handle({ id: "command-2", slotId: "slot-1", kind: "stop", reason: "" });
    await settle();
    expect(start).not.toHaveBeenCalled();
    expect(slots.pendingEvents().map((event) => event.message)).toEqual(["Stopped: the server asked"]);
    expect(asked).toEqual(["open slot-1 #39", "close slot-1 #39"]);
  });

  it("opens a fake pull request when the mock is configured to", async () => {
    const slots = pool("pr-opened");
    slots.handle(START);
    await vi.advanceTimersByTimeAsync(SCRIPT_MS);
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

  it("honours stop: the script goes no further, and the work is reported failed with the reason", async () => {
    const slots = pool("pr-opened");
    slots.handle(START);
    await vi.advanceTimersByTimeAsync(STEP_MS * 2);
    slots.handle({ id: "command-2", slotId: "slot-1", kind: "stop", reason: "CEO changed their mind" });
    expect(slot(slots)?.status).toBe("idle");
    await vi.advanceTimersByTimeAsync(SCRIPT_MS * 2);
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

  it("stops work that runs past the task timeout", async () => {
    const stalled: Agent = { label: "Stuck", start: () => ({ stop: vi.fn() }) };
    const slots = pool("failed", stalled);
    slots.handle(START);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
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

  it("forgets only the events a sync delivered", async () => {
    const slots = pool();
    slots.handle(START);
    await vi.advanceTimersByTimeAsync(SCRIPT_MS);
    slots.delivered(new Set(["event-1"]));
    expect(slots.pendingEvents().map((event) => event.id)).toEqual(["event-2"]);
  });

  it("cuts what an agent says to the contract's budgets", async () => {
    const chatty: Agent = {
      label: "A label far too long for a name",
      start: (_task, reporter) => {
        reporter.started();
        reporter.progress("é".repeat(200));
        waiting = () => reporter.needsInput("ü".repeat(200));
        return { stop: () => undefined };
      },
    };
    let waiting: (() => void) | undefined;
    const slots = pool("failed", chatty);
    slots.handle(START);
    await settle();
    const [report] = slots.report();
    expect(Buffer.byteLength(report?.name ?? "")).toBeLessThanOrEqual(MAX_NAME_LENGTH);
    expect(Buffer.byteLength(report?.activity ?? "")).toBe(MAX_TITLE_LENGTH);
    waiting?.();
    expect(slot(slots)?.status).toBe("needs-input");
    expect(Buffer.byteLength(slot(slots)?.activity ?? "")).toBe(MAX_TITLE_LENGTH);
  });

  it("reports a terminal agent's turn: idle, working, needs-input, turn done, and its exit", async () => {
    let reporter: AgentReporter | undefined;
    const agent: Agent = {
      label: "Claude",
      start: (_task, given) => {
        reporter = given;
        return { stop: () => undefined };
      },
    };
    const slots = pool("failed", agent);
    slots.handle(START);
    await settle();
    reporter?.started();
    expect(slot(slots)).toMatchObject({ status: "idle", issueNumber: 39, activity: "" });
    reporter?.progress("Bash: pnpm test");
    expect(slot(slots)).toMatchObject({ status: "working", issueNumber: 39, activity: "Bash: pnpm test" });
    reporter?.needsInput("Wants permission: Bash: git push");
    expect(slot(slots)).toMatchObject({ status: "needs-input", issueNumber: 39, activity: "Wants permission: Bash: git push" });
    reporter?.turnDone();
    expect(slot(slots)).toMatchObject({ status: "idle", issueNumber: 39, activity: TURN_DONE });
    expect(asked).toEqual(["open slot-1 #39"]);
    reporter?.exited("Claude exited with code 0", true);
    expect(slot(slots)).toMatchObject({ status: "exited", issueNumber: undefined, activity: "" });
    expect(slots.pendingEvents().map((event) => [event.kind, event.message])).toEqual([
      ["started", ""],
      ["finished", "Claude exited with code 0"],
    ]);
    expect(asked).toEqual(["open slot-1 #39", "close slot-1 #39"]);
  });

  it("reports started once, whatever an agent says first, and an exit with an error as failed", async () => {
    let reporter: AgentReporter | undefined;
    const agent: Agent = {
      label: "Claude",
      start: (_task, given) => {
        reporter = given;
        return { stop: () => undefined };
      },
    };
    const slots = pool("failed", agent);
    slots.handle(START);
    await settle();
    reporter?.needsInput("Claude isn't signed in");
    reporter?.started();
    reporter?.exited("Claude exited with code 1", false);
    expect(slots.pendingEvents().map((event) => [event.kind, event.message])).toEqual([
      ["started", ""],
      ["failed", "Claude exited with code 1"],
    ]);
    expect(slot(slots)?.status).toBe("exited");
    slots.handle({ ...START, id: "command-2" });
    expect(slot(slots)).toMatchObject({ status: "starting", issueNumber: 39 });
  });

  it("masks the runner's secrets in what an agent says before it leaves the runner", async () => {
    const secret = "a-runner-secret-long-enough";
    let reporter: AgentReporter | undefined;
    const agent: Agent = {
      label: "Claude",
      start: (_task, given) => {
        reporter = given;
        return { stop: () => undefined };
      },
    };
    const slots = new SlotPool({
      count: 1,
      agent,
      workspaces: workspaces(),
      taskTimeoutMs: TIMEOUT_MS,
      redactor: createRedactor([secret]),
    });
    slots.handle(START);
    await settle();
    reporter?.progress(`Bash: curl -H 'Authorization: ${secret}'`);
    expect(slot(slots)?.activity).not.toContain(secret);
    expect(slot(slots)?.activity).toContain("Authorization: ***");
    reporter?.progress(`Bash: ${"x".repeat(MAX_TITLE_LENGTH - 20)} ${secret}`);
    expect(Buffer.byteLength(slot(slots)?.activity ?? "")).toBe(MAX_TITLE_LENGTH);
    expect(slot(slots)?.activity).toMatch(/ \*+$/);
    reporter?.exited(`Claude exited with code 1: ${secret}`, false);
    const messages = slots.pendingEvents().map((event) => event.message);
    expect(messages.at(-1)).toBe(`Claude exited with code 1: ${"*".repeat(secret.length)}`);
  });

  it("reports nothing an agent says once its work has ended", async () => {
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
    await settle();
    slots.handle({ id: "command-2", slotId: "slot-1", kind: "stop", reason: "" });
    expect(late).toBeDefined();
    late?.();
    expect(slot(slots)?.status).toBe("idle");
    expect(slots.pendingEvents()).toHaveLength(1);
  });
});

describe("SlotPool screens", () => {
  // Real timers: xterm parses what it is fed on a timer of its own.
  beforeEach(() => {
    fixture = gitFixture();
    asked = [];
  });

  afterEach(() => {
    fixture.cleanup();
  });

  /** The text on a slot's screen, row by row, as its next whole frame carries it. */
  async function screenText(slots: SlotPool, id = "slot-1"): Promise<string[]> {
    const mirror = new Map(slots.screens()).get(id);
    await mirror?.written();
    mirror?.sendWhole();
    const frame = mirror?.flush(0, createRedactor([]));
    return Object.values(frame?.lines ?? {})
      .map((runs) => runs.map((run) => run[0]).join(""))
      .filter((text) => text !== "");
  }

  /** An agent whose run prints whatever the test hands `print`, until it is stopped. */
  function printingAgent() {
    const printer: { print?: (data: string) => void } = {};
    const agent: Agent = {
      label: "Echo",
      start: (_task, reporter) => {
        printer.print = (data) => reporter.output(data);
        reporter.started();
        return { stop: () => undefined };
      },
    };
    return { agent, printer };
  }

  it("gives every slot a screen that says it is waiting for work", async () => {
    const slots = pool();
    expect(slots.screens().map(([id]) => id)).toEqual(["slot-1", "slot-2"]);
    expect(await screenText(slots, "slot-2")).toEqual(["Mock 2 is waiting for work."]);
  });

  it("shows what a run prints on a cleared screen, and keeps it there once the run ends", async () => {
    const { agent, printer } = printingAgent();
    const slots = pool("failed", agent);
    slots.handle(START);
    await vi.waitFor(() => expect(printer.print).toBeDefined());
    printer.print?.("\u001b[32mpnpm test\u001b[0m\r\npassed\r\n");
    expect(await screenText(slots)).toEqual(["pnpm test", "passed"]);

    slots.handle({ id: "command-2", slotId: "slot-1", kind: "stop", reason: "" });
    printer.print?.("after the end");
    expect(await screenText(slots)).toEqual(["pnpm test", "passed"]);
    expect(await screenText(slots, "slot-2")).toEqual(["Echo 2 is waiting for work."]);
  });

  it("prints the mock agent's script", async () => {
    const slots = new SlotPool({
      count: 1,
      agent: createMockAgent({ outcome: "pr-opened", repo: REPO, stepMs: 1 }),
      workspaces: workspaces(),
      taskTimeoutMs: TIMEOUT_MS,
    });
    slots.handle(START);
    // `idle` is also the status just after `started`; the run is over once its pull request is open.
    await vi.waitFor(() => expect(slots.pendingEvents().map((event) => event.kind)).toContain("pr-opened"), {
      timeout: 10_000,
    });
    expect(await screenText(slots)).toEqual([
      "mock agent on #39: Night shift",
      "for Dana",
      "● Reading issue #39",
      "● Edit: .sims-mock/issue-39.md",
      "● Bash: git commit",
      "● Bash: pnpm test",
      `✓ Opened https://github.com/${REPO}/pull/1000039`,
    ]);
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
