/**
 * The slot pool with the `mock` agent: a start checks the issue, opens the
 * task's workspace, runs its script to `started`, waits on a person until a
 * prompt answers it, and reaches an outcome there: a failure closes the
 * workspace and leaves the slot idle again, and a simulated pull request keeps
 * the task for rework until a stop. A stop or the task timeout cuts work
 * short, a wait on a person holds the timeout, and everything reported fits
 * the contract's budgets.
 *
 * Fake timers drive the mock's script, so each step is a step of the clock.
 * The workspace is a plain git checkout the mock commits in; real worktrees
 * are `./slotWorktrees.test.ts`'s.
 */

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { type AgentKey, MAX_NAME_LENGTH, MAX_TITLE_LENGTH, type RunnerSlotCommand } from "@sim/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MOCK_PERMISSION,
  MOCK_PERMISSION_CHOICES,
  MOCK_QUESTION,
  MOCK_STEP_USD,
  type MockOutcome,
  createMockAgent,
} from "./agents/mock.js";
import type { Agent, AgentReporter, AgentTask } from "./agents/types.js";
import { SpendLedger } from "./budget.js";
import { type GitFixture, gitFixture } from "./gitFixture.js";
import type { HandInTask, TaskGithub } from "./github.js";
import { createRedactor } from "./redact.js";
import { NO_PULL_REQUEST, type SlotWorkspaces, SlotPool, TURN_DONE, fitBytes } from "./slots.js";

const REPO = "krasovsky22/agent-office-sims";
const STEP_MS = 100;
const TIMEOUT_MS = 60_000;
/** The mock's script from the start command to its wait on a person. */
const TO_WAIT_MS = STEP_MS * 4;
/** The rest of its script, from the answer to its outcome. */
const FROM_ANSWER_MS = STEP_MS * 2;

const START: RunnerSlotCommand = {
  id: "command-1",
  slotId: "slot-1",
  kind: "start",
  issueNumber: 39,
  title: "Night shift",
  url: `https://github.com/${REPO}/issues/39`,
  note: "",
  requestedBy: "Dana",
};

/** The CEO's answer to what the mock waits on. */
const ANSWER: RunnerSlotCommand = { id: "command-answer", slotId: "slot-1", kind: "prompt", text: "Go ahead.", requestedBy: "Dana" };

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

function pool(outcome: MockOutcome = "failed", agent?: Agent, spaces = workspaces(), github?: TaskGithub) {
  let nextId = 1;
  return new SlotPool({
    count: 2,
    agent: agent ?? createMockAgent({ outcome, stepMs: STEP_MS }),
    workspaces: spaces,
    taskTimeoutMs: TIMEOUT_MS,
    eventId: () => `event-${nextId++}`,
    ...(github === undefined ? {} : { github }),
  });
}

/** Lets an opened workspace reach the agent waiting on it. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function slot(slots: SlotPool, id = "slot-1") {
  return slots.report().find((candidate) => candidate.id === id);
}

/** Runs the mock's whole script to its outcome, answering its wait on a person. */
async function runScript(slots: SlotPool): Promise<void> {
  await vi.advanceTimersByTimeAsync(TO_WAIT_MS);
  slots.handle(ANSWER);
  await vi.advanceTimersByTimeAsync(FROM_ANSWER_MS);
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
    expect(slot(slots)).toMatchObject({ status: "starting", issueNumber: 39, activity: "Checking #39 on GitHub" });
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

    // It waits on a person, still holding its issue, for as long as nobody
    // answers: the wait never ends on its own, and the task timeout is held.
    await vi.advanceTimersByTimeAsync(STEP_MS);
    expect(slot(slots)).toMatchObject({ status: "needs-input", issueNumber: 39, activity: MOCK_PERMISSION });
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 3);
    expect(slot(slots)).toMatchObject({ status: "needs-input", issueNumber: 39, activity: MOCK_PERMISSION });
    expect(slots.pendingEvents().map((event) => event.kind)).toEqual(["started"]);

    // A prompt is the answer, and it carries on.
    slots.handle(ANSWER);
    expect(slot(slots)).toMatchObject({ status: "working", activity: "Go ahead." });
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
      await runScript(slots);
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
    let opened: ((workdir: string) => void) | undefined;
    const slots = pool("failed", { label: "Spy", start }, {
      open: (slotId, issueNumber) => {
        asked.push(`open ${slotId} #${issueNumber}`);
        return new Promise((resolve) => {
          opened = resolve;
        });
      },
      close: async (slotId, issueNumber) => {
        asked.push(`close ${slotId} #${issueNumber}`);
      },
    });
    slots.handle(START);
    await settle();
    slots.handle({ id: "command-2", slotId: "slot-1", kind: "stop", reason: "" });
    opened?.(fixture.developer);
    await settle();
    expect(start).not.toHaveBeenCalled();
    expect(slots.pendingEvents().map((event) => event.message)).toEqual(["Stopped: the server asked"]);
    expect(asked).toEqual(["open slot-1 #39", "close slot-1 #39"]);
  });

  it("starts no agent, and opens no workspace, for work stopped while its issue was being checked", async () => {
    const start = vi.fn();
    const slots = pool("failed", { label: "Spy", start });
    slots.handle(START);
    slots.handle({ id: "command-2", slotId: "slot-1", kind: "stop", reason: "" });
    await settle();
    expect(start).not.toHaveBeenCalled();
    expect(asked).toEqual(["close slot-1 #39"]);
  });

  it("logs a task's lifecycle, and every step it works only to debug", async () => {
    const log: string[] = [];
    const debug: string[] = [];
    const slots = new SlotPool({
      count: 1,
      agent: createMockAgent({ outcome: "pr-opened", stepMs: STEP_MS }),
      workspaces: workspaces(),
      taskTimeoutMs: TIMEOUT_MS,
      log: (line) => log.push(line),
      debug: (line) => debug.push(line),
    });
    slots.handle(START);
    await runScript(slots);
    slots.handle({ ...START, id: "command-2", issueNumber: 40 });
    slots.handle({ id: "command-3", slotId: "slot-1", kind: "stop", reason: "" });
    expect(log).toEqual([
      "slot-1 starting on #39 for Dana with the Mock agent: simulated work, nothing real is done on the issue",
      "slot-1 on #39: the Mock agent runs inside the runner",
      "slot-1 on #39: its agent is up",
      "slot-1 on #39 is working",
      `slot-1 on #39 needs a person: ${MOCK_PERMISSION}`,
      "slot-1 given a prompt by the server on #39",
      "slot-1 on #39 is working",
      "slot-1 handed in #39: a simulated pull request; nothing was opened on GitHub",
      "slot-1 on #39: its agent's turn ended",
      "start for slot-1 on #40 refused: Mock 1 is busy with #39",
      `slot-1 failed on #39: Stopped: the server asked (${"$"}${(MOCK_STEP_USD * 4).toFixed(2)} spent)`,
    ]);
    expect(debug).toContain("slot-1 checking #39 on GitHub");
    expect(debug).toContain("slot-1 on #39: Bash: git commit");
    // The answer's words are the agent's business, not the log's.
    expect([...log, ...debug].join("\n")).not.toContain("Go ahead.");
  });

  it("masks the runner's secrets in the reason a task ended", async () => {
    const log: string[] = [];
    const slots = new SlotPool({
      count: 1,
      agent: { label: "Spy", start: () => ({ stop: () => undefined }) },
      workspaces: workspaces(),
      taskTimeoutMs: TIMEOUT_MS,
      redactor: createRedactor(["hunter2-secret-value"]),
      log: (line) => log.push(line),
    });
    slots.handle(START);
    await settle();
    slots.handle({ id: "command-2", slotId: "slot-1", kind: "stop", reason: "token hunter2-secret-value leaked" });
    expect(log.at(-1)).toMatch(/^slot-1 failed on #39: Stopped: token \*+ leaked/);
  });

  it("hands in a simulated pull request when the mock is configured to, and keeps the task for review", async () => {
    const log: string[] = [];
    const slots = new SlotPool({
      count: 1,
      agent: createMockAgent({ outcome: "pr-opened", stepMs: STEP_MS }),
      workspaces: workspaces(),
      taskTimeoutMs: TIMEOUT_MS,
      eventId: (() => {
        let next = 1;
        return () => `event-${next++}`;
      })(),
      log: (line) => log.push(line),
    });
    slots.handle(START);
    await runScript(slots);
    // Nothing on GitHub: no link to it, and it says it is simulated.
    const pr = { number: 1_000_039, title: "[mock] Night shift", url: "", simulated: true };
    expect(slot(slots)).toMatchObject({ status: "idle", issueNumber: 39, activity: TURN_DONE, pr });
    expect(slots.pendingEvents()[1]).toEqual({
      id: "event-2",
      kind: "pr-opened",
      slotId: "slot-1",
      issueNumber: 39,
      pr,
      message: "",
    });
    expect(log).toContain("slot-1 handed in #39: a simulated pull request; nothing was opened on GitHub");
    expect(log.join("\n")).not.toContain("github.com");
    // Handed in, the work waits on review rather than the task timeout, its worktree kept.
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 2);
    expect(slot(slots)?.issueNumber).toBe(39);
    expect(slots.pendingEvents()).toHaveLength(2);
    expect(asked).toEqual(["open slot-1 #39"]);
  });

  it("takes a rework prompt, hands the same pull request in again, and gives the task up when stopped", async () => {
    const slots = pool("pr-opened");
    slots.handle(START);
    await runScript(slots);
    slots.handle({ id: "command-2", slotId: "slot-1", kind: "prompt", text: "Rename the lift.", requestedBy: "Dana" });
    expect(slot(slots)).toMatchObject({ status: "working", issueNumber: 39, activity: "Rename the lift.", pr: { number: 1_000_039 } });
    await vi.advanceTimersByTimeAsync(STEP_MS * 6);
    expect(slot(slots)).toMatchObject({ status: "idle", issueNumber: 39, activity: TURN_DONE });
    expect(slots.pendingEvents().map((event) => [event.kind, event.pr?.number])).toEqual([
      ["started", undefined],
      ["pr-opened", 1_000_039],
      ["pr-opened", 1_000_039],
    ]);
    expect(fixture.git(fixture.developer, "log", "-1", "--format=%s")).toBe("mock: rework #39");

    // A stop for an issue it has left behind is not for this work.
    slots.handle({ id: "command-3", slotId: "slot-1", kind: "stop", reason: "", issueNumber: 40 });
    expect(slot(slots)?.issueNumber).toBe(39);
    slots.handle({ id: "command-4", slotId: "slot-1", kind: "stop", reason: "the work is done", issueNumber: 39 });
    expect(slot(slots)).toMatchObject({ status: "idle", issueNumber: undefined, pr: undefined });
    expect(slots.pendingEvents().at(-1)).toMatchObject({ kind: "failed", message: "Stopped: the work is done" });
    expect(asked).toEqual(["open slot-1 #39", "close slot-1 #39"]);
  });

  it("takes a start for the issue it already holds as a prompt with the start's note", async () => {
    const slots = pool("pr-opened");
    slots.handle(START);
    await runScript(slots);
    slots.handle({ ...START, id: "command-2", note: "Rename the lift." });
    expect(slot(slots)).toMatchObject({ status: "working", activity: "Rename the lift." });
    expect(asked).toEqual(["open slot-1 #39"]);
  });

  it("says again how far it got when started on the issue it holds, as after a server restart", async () => {
    const slots = pool("pr-opened");
    slots.handle(START);
    await runScript(slots);
    slots.delivered(new Set(slots.pendingEvents().map((event) => event.id)));
    slots.handle({ ...START, id: "command-2" });
    expect(slots.pendingEvents().map((event) => [event.kind, event.pr?.number])).toEqual([
      ["started", undefined],
      ["pr-opened", 1_000_039],
    ]);
    expect(slot(slots)).toMatchObject({ status: "idle", issueNumber: 39, activity: TURN_DONE });
  });

  it("refuses an issue GitHub says may not be worked, before it opens a workspace", async () => {
    const start = vi.fn();
    const slots = pool("failed", { label: "Spy", start }, workspaces(), {
      refusal: async () => "#39 is not labelled agent-ready on GitHub, so no agent may work it",
      pullRequest: async () => undefined,
      pullRequestTitle: async () => "",
    });
    slots.handle(START);
    await settle();
    expect(start).not.toHaveBeenCalled();
    expect(slot(slots)).toMatchObject({ status: "idle", issueNumber: undefined });
    expect(slots.pendingEvents()).toEqual([
      {
        id: "event-1",
        kind: "failed",
        slotId: "slot-1",
        issueNumber: 39,
        pr: undefined,
        message: "#39 is not labelled agent-ready on GitHub, so no agent may work it",
      },
    ]);
    expect(asked).toEqual(["close slot-1 #39"]);
  });

  it("finds the pull request a turn ended without reporting, and hands it in", async () => {
    let reporter: AgentReporter | undefined;
    const pullRequest = vi.fn(async (task: HandInTask) => {
      expect(task).toEqual({ issueNumber: 39, title: "Night shift", workdir: fixture.developer, requestedBy: "Dana", agentName: "Claude 1" });
      return { number: 95, title: "Night shift", url: `https://github.com/${REPO}/pull/95` };
    });
    const agent: Agent = {
      label: "Claude",
      start: (_task, given) => {
        reporter = given;
        return { stop: () => undefined };
      },
    };
    const slots = pool("failed", agent, workspaces(), { refusal: async () => undefined, pullRequest, pullRequestTitle: async () => "" });
    slots.handle(START);
    await settle();
    reporter?.progress("Bash: git push");
    reporter?.turnDone();
    await settle();
    expect(pullRequest).toHaveBeenCalledTimes(1);
    expect(slot(slots)).toMatchObject({ status: "idle", issueNumber: 39, activity: TURN_DONE, pr: { number: 95 } });
    expect(slots.pendingEvents().map((event) => [event.kind, event.pr?.url])).toEqual([
      ["started", undefined],
      ["pr-opened", `https://github.com/${REPO}/pull/95`],
    ]);
    // Handed in: later turns look for nothing.
    reporter?.turnDone();
    await settle();
    expect(pullRequest).toHaveBeenCalledTimes(1);
  });

  it("hands in a pull request its agent reports once, and says why when GitHub cannot be asked", async () => {
    let reporter: AgentReporter | undefined;
    const agent: Agent = {
      label: "Claude",
      start: (_task, given) => {
        reporter = given;
        return { stop: () => undefined };
      },
    };
    const slots = pool("failed", agent, workspaces(), {
      refusal: async () => undefined,
      pullRequest: async () => {
        throw new Error("gh: HTTP 401");
      },
      pullRequestTitle: async () => "",
    });
    slots.handle(START);
    await settle();
    reporter?.progress("Bash: pnpm test");
    reporter?.turnDone();
    await settle();
    expect(slot(slots)).toMatchObject({ status: "needs-input", activity: `${NO_PULL_REQUEST} that the runner could find: gh: HTTP 401` });

    reporter?.progress("Bash: gh pr create");
    const pr = { number: 96, title: "", url: `https://github.com/${REPO}/pull/96` };
    reporter?.prOpened(pr);
    reporter?.prOpened(pr);
    await settle();
    expect(slots.pendingEvents().filter((event) => event.kind === "pr-opened")).toHaveLength(1);
    expect(slot(slots)).toMatchObject({ status: "working", pr });
  });

  it("asks GitHub for the title of a pull request its agent reports without one", async () => {
    let reporter: AgentReporter | undefined;
    const agent: Agent = {
      label: "Claude",
      start: (_task, given) => {
        reporter = given;
        return { stop: () => undefined };
      },
    };
    const pullRequestTitle = vi.fn(async () => "Night shift");
    const slots = pool("failed", agent, workspaces(), { refusal: async () => undefined, pullRequest: async () => undefined, pullRequestTitle });
    slots.handle(START);
    await settle();
    reporter?.progress("Bash: gh pr create");
    reporter?.prOpened({ number: 96, title: "", url: `https://github.com/${REPO}/pull/96` });
    await settle();
    expect(pullRequestTitle).toHaveBeenCalledWith(96);
    expect(slots.pendingEvents().find((event) => event.kind === "pr-opened")?.pr).toEqual({
      number: 96,
      title: "Night shift",
      url: `https://github.com/${REPO}/pull/96`,
    });
  });

  it("counts a reported pull request handed in while its title is being looked up", async () => {
    let reporter: AgentReporter | undefined;
    const agent: Agent = {
      label: "Claude",
      start: (_task, given) => {
        reporter = given;
        return { stop: () => undefined };
      },
    };
    let giveTitle: (title: string) => void = () => undefined;
    const pullRequest = vi.fn(async () => undefined);
    const pullRequestTitle = vi.fn(() => new Promise<string>((resolve) => (giveTitle = resolve)));
    const slots = pool("failed", agent, workspaces(), { refusal: async () => undefined, pullRequest, pullRequestTitle });
    slots.handle(START);
    await settle();
    reporter?.progress("Bash: gh pr create");
    reporter?.prOpened({ number: 96, title: "", url: `https://github.com/${REPO}/pull/96` });
    reporter?.turnDone();
    await settle();
    expect(pullRequest).not.toHaveBeenCalled();
    expect(slot(slots)).toMatchObject({ status: "idle", activity: TURN_DONE });
    expect(slots.pendingEvents().filter((event) => event.kind === "pr-opened")).toHaveLength(0);

    giveTitle("Night shift");
    await settle();
    expect(slot(slots)).toMatchObject({ status: "idle", pr: { number: 96, title: "Night shift" } });
    expect(slots.pendingEvents().filter((event) => event.kind === "pr-opened").map((event) => event.pr?.title)).toEqual(["Night shift"]);
  });

  it("honours stop: the script goes no further, and the work is reported failed with the reason", async () => {
    const slots = pool("pr-opened");
    slots.handle(START);
    await vi.advanceTimersByTimeAsync(STEP_MS * 2);
    slots.handle({ id: "command-2", slotId: "slot-1", kind: "stop", reason: "CEO changed their mind" });
    expect(slot(slots)?.status).toBe("idle");
    await vi.advanceTimersByTimeAsync(TO_WAIT_MS * 2);
    slots.handle(ANSWER);
    await vi.advanceTimersByTimeAsync(FROM_ANSWER_MS * 2);
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

  it("holds the task timeout while its agent waits on a person, and counts on from there once it works again", async () => {
    let reporter: AgentReporter | undefined;
    const agent: Agent = {
      label: "Asker",
      start: (_task, given) => {
        reporter = given;
        return { stop: () => undefined };
      },
    };
    const slots = pool("failed", agent);
    slots.handle(START);
    await settle();
    reporter?.progress("Bash: pnpm test");
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 0.4);
    reporter?.needsInput("Wants permission: Bash: git push");
    // However long the person takes, the agent is not taking too long.
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 5);
    expect(slot(slots)).toMatchObject({ status: "needs-input", issueNumber: 39 });
    expect(slots.pendingEvents().map((event) => event.kind)).toEqual(["started"]);

    reporter?.progress("Bash: git push");
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 0.6 - 1);
    expect(slot(slots)).toMatchObject({ status: "working", issueNumber: 39 });
    await vi.advanceTimersByTimeAsync(1);
    expect(slot(slots)).toMatchObject({ status: "idle", issueNumber: undefined });
    expect(slots.pendingEvents().at(-1)).toMatchObject({ kind: "failed", message: "Timed out after 1 minute" });
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

  it("ignores a command for a slot it does not have, and a prompt for a slot holding no task", () => {
    const slots = pool();
    slots.handle({ ...START, slotId: "slot-9" });
    slots.handle({ id: "command-2", slotId: "slot-1", kind: "prompt", text: "hurry", requestedBy: "Dana" });
    expect(slots.report().every((report) => report.status === "idle")).toBe(true);
    expect(slots.pendingEvents()).toEqual([]);
  });

  it("forgets only the events a sync delivered", async () => {
    const slots = pool();
    slots.handle(START);
    await runScript(slots);
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
    expect(slot(slots)).toMatchObject({ status: "idle", issueNumber: 39, activity: "Looking for its pull request" });
    await settle();
    // Nothing handed in, and none to be found: it needs a person, still holding its issue.
    expect(slot(slots)).toMatchObject({ status: "needs-input", issueNumber: 39, activity: NO_PULL_REQUEST });
    reporter?.turnDone();
    expect(slot(slots)).toMatchObject({ status: "needs-input", activity: NO_PULL_REQUEST });
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

describe("SlotPool spend", () => {
  beforeEach(() => {
    fixture = gitFixture();
    asked = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    fixture.cleanup();
  });

  /** An agent that is up and waits, handing its reporter out so a test can speak for it. */
  function waitingAgent(reporters: AgentReporter[]): Agent {
    return {
      label: "Paid",
      start: (_task, reporter) => {
        reporters.push(reporter);
        reporter.started();
        return { stop: () => undefined };
      },
    };
  }

  function budgeted(agent: Agent, budgetUsd: number | undefined) {
    let nextId = 1;
    return new SlotPool({
      count: 2,
      agent,
      workspaces: workspaces(),
      taskTimeoutMs: TIMEOUT_MS,
      eventId: () => `event-${nextId++}`,
      ledger: new SpendLedger({ budgetUsd, now: () => new Date(2026, 9, 16, 12) }),
    });
  }

  it("books each task's running total once, its last turn too after it was stopped", async () => {
    const reporters: AgentReporter[] = [];
    const slots = budgeted(waitingAgent(reporters), undefined);
    slots.handle(START);
    slots.handle({ ...START, id: "command-2", slotId: "slot-2", issueNumber: 40 });
    await settle();
    const [first, second] = reporters;
    first?.spent(0.5);
    first?.spent(1.25);
    second?.spent(0.25);
    expect(slots.spend()).toEqual({ spentUsd: 1.5, budgetUsd: undefined });

    slots.handle({ id: "command-3", slotId: "slot-1", kind: "stop", reason: "" });
    first?.spent(1.5);
    expect(slots.spend().spentUsd).toBe(1.75);
  });

  it("counts the mock's pretend spend, step by step", async () => {
    const slots = budgeted(createMockAgent({ outcome: "failed", stepMs: STEP_MS }), undefined);
    slots.handle(START);
    await settle();
    await runScript(slots);
    expect(slots.spend().spentUsd).toBeCloseTo(4 * MOCK_STEP_USD);
  });

  it("refuses a start once the day's budget is spent, as a failed start marked as the budget's", async () => {
    const reporters: AgentReporter[] = [];
    const slots = budgeted(waitingAgent(reporters), 2);
    slots.handle(START);
    await settle();
    reporters[0]?.spent(2.5);
    slots.delivered(new Set(slots.pendingEvents().map((event) => event.id)));

    slots.handle({ ...START, id: "command-2", slotId: "slot-2", issueNumber: 40 });
    await settle();
    expect(reporters).toHaveLength(1);
    expect(slot(slots, "slot-2")).toMatchObject({ status: "idle", issueNumber: undefined });
    expect(asked).toEqual(["open slot-1 #39"]);
    expect(slots.pendingEvents()).toEqual([
      {
        id: "event-2",
        kind: "failed",
        slotId: "slot-2",
        issueNumber: 40,
        pr: undefined,
        message: "The runner's daily budget of $2.00 is spent ($2.50 today), so it starts no new work until midnight on its machine",
        refusal: "budget",
      },
    ]);
    // Work already under way carries on, and a start it already holds is not new work.
    slots.handle({ ...START, id: "command-3" });
    expect(slot(slots)).toMatchObject({ status: "idle", issueNumber: 39 });
    expect(slots.pendingEvents().filter((event) => event.refusal !== undefined)).toHaveLength(1);
  });
});

describe("SlotPool prompts from the CEO", () => {
  beforeEach(() => {
    fixture = gitFixture();
    asked = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    fixture.cleanup();
  });

  let nextCommand = 10;
  function ceoPrompt(text: string): RunnerSlotCommand {
    nextCommand += 1;
    return { id: `command-${nextCommand}`, slotId: "slot-1", kind: "prompt", text, requestedBy: "Dana", fromCeo: true };
  }

  /** A terminal agent driven by the test, recording what is typed into it. */
  function promptedAgent(takesPrompts = true) {
    const typed: string[] = [];
    const handle: { reporter?: AgentReporter } = {};
    const agent: Agent = {
      label: "Claude",
      start: (_task, reporter) => {
        handle.reporter = reporter;
        return takesPrompts ? { stop: () => undefined, prompt: (text) => typed.push(text) } : { stop: () => undefined };
      },
    };
    return { agent, typed, handle };
  }

  it("types a prompt only once the agent's turn is done, and says what came of each", async () => {
    const { agent, typed, handle } = promptedAgent();
    const slots = pool("failed", agent);
    const outcomes = () => slots.pendingPromptOutcomes().map((outcome) => outcome.outcome);

    // No task to be at a prompt for.
    slots.handle(ceoPrompt("anyone there?"));
    slots.handle(START);
    // Still checking the issue and starting.
    slots.handle(ceoPrompt("hurry"));
    await settle();
    slots.handle(ceoPrompt("hurry up"));
    handle.reporter?.progress("Bash: pnpm test");
    slots.handle(ceoPrompt("stop that"));
    handle.reporter?.needsInput("Wants permission: Bash: git push");
    slots.handle(ceoPrompt("yes"));
    // Its turn ended: while it looks for the pull request it is still busy.
    handle.reporter?.turnDone();
    slots.handle(ceoPrompt("well?"));
    expect(typed).toEqual([]);
    expect(outcomes()).toEqual(["unavailable", "busy", "busy", "busy", "needs-input", "busy"]);

    await settle();
    expect(slot(slots)).toMatchObject({ status: "needs-input", activity: NO_PULL_REQUEST });
    const answer = ceoPrompt("Yes, cover the empty case.\nThen open the pull request.");
    slots.handle(answer);
    expect(typed).toEqual(["Yes, cover the empty case.\nThen open the pull request."]);
    expect(slot(slots)).toMatchObject({ status: "working", issueNumber: 39, activity: "Yes, cover the empty case." });
    expect(slots.pendingPromptOutcomes().at(-1)).toEqual({ commandId: answer.id, slotId: "slot-1", outcome: "delivered" });

    // Back at its prompt after a turn with its work handed in, it is free again.
    handle.reporter?.prOpened({ number: 41, title: "Night shift", url: `https://github.com/${REPO}/pull/41` });
    handle.reporter?.turnDone();
    slots.handle(ceoPrompt("thanks"));
    expect(typed).toHaveLength(2);
    expect(outcomes().at(-1)).toBe("delivered");
  });

  it("types the CEO's prompt as the answer to a mock waiting on a person, and refuses it at a real agent's permission", async () => {
    const slots = pool("pr-opened");
    slots.handle(START);
    await vi.advanceTimersByTimeAsync(TO_WAIT_MS);
    expect(slot(slots)).toMatchObject({ status: "needs-input", activity: MOCK_PERMISSION });
    const answer = ceoPrompt("Go ahead and run the tests.");
    slots.handle(answer);
    expect(slots.pendingPromptOutcomes()).toEqual([{ commandId: answer.id, slotId: "slot-1", outcome: "delivered" }]);
    expect(slot(slots)).toMatchObject({ status: "working", activity: "Go ahead and run the tests." });
    await vi.advanceTimersByTimeAsync(FROM_ANSWER_MS);
    expect(slot(slots)).toMatchObject({ status: "idle", issueNumber: 39, activity: TURN_DONE, pr: { simulated: true } });

    // A dialog would take the Enter after the paste as its choice, whatever the prompt said.
    const { agent, typed, handle } = promptedAgent();
    const real = pool("failed", agent);
    real.handle(START);
    await settle();
    handle.reporter?.needsInput("Wants permission: Bash: git push");
    real.handle(ceoPrompt("No, don't push."));
    expect(typed).toEqual([]);
    expect(real.pendingPromptOutcomes().map((outcome) => outcome.outcome)).toEqual(["needs-input"]);
  });

  it("forgets the outcomes a sync delivered, by their command's id", () => {
    const slots = pool();
    const first = ceoPrompt("one");
    const second = ceoPrompt("two");
    slots.handle(first);
    slots.handle(second);
    slots.delivered(new Set([first.id]));
    expect(slots.pendingPromptOutcomes().map((outcome) => outcome.commandId)).toEqual([second.id]);
  });

  it("refuses a prompt for an agent that takes none", async () => {
    const { agent, handle } = promptedAgent(false);
    const slots = pool("failed", agent);
    slots.handle(START);
    await settle();
    handle.reporter?.turnDone();
    await settle();
    slots.handle(ceoPrompt("hello"));
    expect(slots.pendingPromptOutcomes().map((outcome) => outcome.outcome)).toEqual(["unavailable"]);
  });

  it("still gives the office's own rework prompt whatever the agent is doing, and reports nothing for it", async () => {
    const { agent, typed, handle } = promptedAgent();
    const slots = pool("failed", agent);
    slots.handle(START);
    await settle();
    handle.reporter?.progress("Bash: pnpm test");
    slots.handle({ id: "command-2", slotId: "slot-1", kind: "prompt", text: "Rework it.", requestedBy: "Dana" });
    expect(typed).toEqual(["Rework it."]);
    expect(slots.pendingPromptOutcomes()).toEqual([]);
  });

  it("has a mock asking a question wait at its desk until the CEO answers, then hand in", async () => {
    const slots = pool("question");
    slots.handle(START);
    await runScript(slots);
    // Its turn is over with nothing handed in: it waits at its prompt, holding the issue.
    expect(slot(slots)).toMatchObject({ status: "needs-input", issueNumber: 39, activity: NO_PULL_REQUEST, pr: undefined });
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS / 2);
    expect(slot(slots)?.issueNumber).toBe(39);

    const answer = ceoPrompt("Yes, the empty case too.");
    slots.handle(answer);
    expect(slots.pendingPromptOutcomes()).toEqual([{ commandId: answer.id, slotId: "slot-1", outcome: "delivered" }]);
    expect(slot(slots)).toMatchObject({ status: "working", activity: "Yes, the empty case too." });
    await vi.advanceTimersByTimeAsync(STEP_MS * 6);
    expect(slot(slots)).toMatchObject({ status: "idle", issueNumber: 39, activity: TURN_DONE, pr: { number: 1_000_039 } });
    expect(slots.pendingEvents().map((event) => event.kind)).toEqual(["started", "pr-opened"]);
  });
});

describe("SlotPool keys from the CEO", () => {
  beforeEach(() => {
    fixture = gitFixture();
    asked = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    fixture.cleanup();
  });

  let nextCommand = 100;
  function ceoKey(key: AgentKey): RunnerSlotCommand {
    nextCommand += 1;
    return { id: `command-${nextCommand}`, slotId: "slot-1", kind: "key", key, requestedBy: "Dana" };
  }

  /** A terminal agent driven by the test, recording the keys pressed in it. */
  function keyedAgent(takesKeys = true) {
    const pressed: AgentKey[] = [];
    const handle: { reporter?: AgentReporter } = {};
    const agent: Agent = {
      label: "Claude",
      start: (_task, reporter) => {
        handle.reporter = reporter;
        return takesKeys ? { stop: () => undefined, key: (key) => pressed.push(key) } : { stop: () => undefined };
      },
    };
    return { agent, pressed, handle };
  }

  it("presses a key only while the agent waits on a person, says what came of each, and logs each", async () => {
    const { agent, pressed, handle } = keyedAgent();
    const lines: string[] = [];
    const slots = new SlotPool({ count: 1, agent, workspaces: workspaces(), taskTimeoutMs: TIMEOUT_MS, log: (line) => lines.push(line) });
    const outcomes = () => slots.pendingPromptOutcomes().map((outcome) => outcome.outcome);

    slots.handle(ceoKey("enter"));
    slots.handle(START);
    await settle();
    handle.reporter?.progress("Bash: pnpm test");
    slots.handle(ceoKey("enter"));
    handle.reporter?.needsInput("Wants permission: Bash: git push");
    slots.handle(ceoKey("down"));
    slots.handle(ceoKey("enter"));
    expect(pressed).toEqual(["down", "enter"]);
    expect(outcomes()).toEqual(["unavailable", "not-waiting", "delivered", "delivered"]);
    expect(lines).toContain("key Enter for slot-1 from Dana not pressed: unavailable");
    expect(lines).toContain("key Enter for slot-1 from Dana not pressed: not-waiting");
    expect(lines).toContain("slot-1 on #39: Dana pressed Down");
    expect(lines).toContain("slot-1 on #39: Dana pressed Enter");

    // A turn that ended with nothing handed in leaves it at its prompt, where a prompt is the answer, not a key.
    handle.reporter?.turnDone();
    await settle();
    expect(slot(slots)).toMatchObject({ status: "needs-input", activity: NO_PULL_REQUEST });
    slots.handle(ceoKey("escape"));
    expect(pressed).toHaveLength(2);
    expect(outcomes().at(-1)).toBe("not-waiting");
  });

  it("refuses a key for an agent with no screen to press it on", async () => {
    const { agent, handle } = keyedAgent(false);
    const slots = pool("failed", agent);
    slots.handle(START);
    await settle();
    handle.reporter?.needsInput("Waiting on a person");
    slots.handle(ceoKey("enter"));
    expect(slots.pendingPromptOutcomes().map((outcome) => outcome.outcome)).toEqual(["unavailable"]);
  });

  it("answers the mock's permission menu with keys: moving to yes and confirming has it carry on and hand in", async () => {
    const slots = pool("pr-opened");
    slots.handle(START);
    await vi.advanceTimersByTimeAsync(TO_WAIT_MS);
    expect(slot(slots)).toMatchObject({ status: "needs-input", activity: MOCK_PERMISSION });
    slots.handle(ceoKey("down"));
    slots.handle(ceoKey("up"));
    slots.handle(ceoKey("enter"));
    expect(slots.pendingPromptOutcomes().map((outcome) => outcome.outcome)).toEqual(["delivered", "delivered", "delivered"]);
    await vi.advanceTimersByTimeAsync(FROM_ANSWER_MS);
    expect(slot(slots)).toMatchObject({ status: "idle", issueNumber: 39, activity: TURN_DONE, pr: { simulated: true } });
  });

  it("has the mock told no with Esc end its turn and wait at its prompt for what to do instead", async () => {
    const slots = pool("pr-opened");
    slots.handle(START);
    await vi.advanceTimersByTimeAsync(TO_WAIT_MS);
    slots.handle(ceoKey("escape"));
    await settle();
    expect(slot(slots)).toMatchObject({ status: "needs-input", issueNumber: 39, activity: NO_PULL_REQUEST, pr: undefined });
    slots.handle(ceoKey("enter"));
    expect(slots.pendingPromptOutcomes().map((outcome) => outcome.outcome)).toEqual(["delivered", "not-waiting"]);
    // Told what to do instead, it does it, and hands in.
    slots.handle({ id: "command-told", slotId: "slot-1", kind: "prompt", text: "Skip the tests.", requestedBy: "Dana", fromCeo: true });
    await vi.advanceTimersByTimeAsync(STEP_MS * 6);
    expect(slot(slots)).toMatchObject({ status: "idle", activity: TURN_DONE, pr: { simulated: true } });
  });

  it("has the mock take a number as the choice it names", async () => {
    const slots = pool("pr-opened");
    slots.handle(START);
    await vi.advanceTimersByTimeAsync(TO_WAIT_MS);
    // Past its choices: nothing happens.
    slots.handle(ceoKey("9"));
    await vi.advanceTimersByTimeAsync(FROM_ANSWER_MS);
    expect(slot(slots)).toMatchObject({ status: "needs-input", activity: MOCK_PERMISSION });
    slots.handle(ceoKey("2"));
    await settle();
    expect(slot(slots)).toMatchObject({ status: "needs-input", activity: NO_PULL_REQUEST });
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
      agent: createMockAgent({ outcome: "pr-opened", stepMs: 1 }),
      workspaces: workspaces(),
      taskTimeoutMs: TIMEOUT_MS,
    });
    slots.handle(START);
    await vi.waitFor(() => expect(slot(slots)?.status).toBe("needs-input"), { timeout: 10_000 });
    slots.handle(ANSWER);
    // `idle` is also the status just after `started`; the run is over once its pull request is handed in.
    await vi.waitFor(() => expect(slots.pendingEvents().map((event) => event.kind)).toContain("pr-opened"), {
      timeout: 10_000,
    });
    const screen = await screenText(slots);
    expect(screen).toEqual([
      "mock agent on #39: Night shift",
      "for Dana",
      "● Reading issue #39",
      "● Edit: .sims-mock/issue-39.md",
      "● Bash: git commit",
      `? ${MOCK_PERMISSION}`,
      "  Do you want to proceed?",
      "❯ 1. Yes",
      "  2. No, and tell the agent what to do differently (esc)",
      "  ↑/↓ to move · Enter to confirm · Esc to cancel",
      "> Go ahead.",
      "● Bash: pnpm test",
      "✓ Handed in a simulated pull request; nothing was opened on GitHub",
    ]);
    expect(screen.join("\n")).not.toContain("github.com");
  });

  it("draws the mock's permission menu, and moves its pointer as the CEO presses keys", async () => {
    const slots = new SlotPool({
      count: 1,
      agent: createMockAgent({ outcome: "pr-opened", stepMs: 1 }),
      workspaces: workspaces(),
      taskTimeoutMs: TIMEOUT_MS,
    });
    slots.handle(START);
    await vi.waitFor(() => expect(slot(slots)?.activity).toBe(MOCK_PERMISSION), { timeout: 10_000 });
    expect(await screenText(slots)).toEqual(
      expect.arrayContaining([`❯ 1. ${MOCK_PERMISSION_CHOICES[0]}`, `  2. ${MOCK_PERMISSION_CHOICES[1]}`]),
    );
    slots.handle({ id: "command-2", slotId: "slot-1", kind: "key", key: "down", requestedBy: "Dana" });
    const text = await screenText(slots);
    expect(text).toEqual(expect.arrayContaining([`  1. ${MOCK_PERMISSION_CHOICES[0]}`, `❯ 2. ${MOCK_PERMISSION_CHOICES[1]}`]));
    // Drawn over itself: the menu is there once, its hint under it.
    expect(text.filter((line) => line.includes(MOCK_PERMISSION_CHOICES[0]))).toHaveLength(1);
    expect(text.at(-1)).toMatch(/Enter to confirm/);
  });

  it("prints the mock's question, and the CEO's answer typed to it", async () => {
    const slots = new SlotPool({
      count: 1,
      agent: createMockAgent({ outcome: "question", stepMs: 1 }),
      workspaces: workspaces(),
      taskTimeoutMs: TIMEOUT_MS,
    });
    slots.handle(START);
    await vi.waitFor(() => expect(slot(slots)?.activity).toBe(MOCK_PERMISSION), { timeout: 10_000 });
    slots.handle(ANSWER);
    await vi.waitFor(() => expect(slot(slots)?.activity).toBe(NO_PULL_REQUEST), { timeout: 10_000 });
    slots.handle({ id: "command-2", slotId: "slot-1", kind: "prompt", text: "Yes.\nBoth cases.", requestedBy: "Dana", fromCeo: true });
    await vi.waitFor(() => expect(slots.pendingEvents().map((event) => event.kind)).toContain("pr-opened"), {
      timeout: 10_000,
    });
    const text = await screenText(slots);
    expect(text).toContain(`? ${MOCK_QUESTION}`);
    expect(text).toContain("> Yes.");
    expect(text).toContain("  Both cases.");
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
