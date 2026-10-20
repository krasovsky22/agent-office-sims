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

import { type AgentProfile, MAX_NAME_LENGTH, MAX_TITLE_LENGTH, defaultAgentProfile } from "@sim/shared";
import { describe, expect, it, vi } from "vitest";

import { MOCK_PERMISSION, MOCK_STEP_USD, createMockAgent } from "./agents/mock.js";
import { systemPrompt } from "./agents/prompt.js";
import type { Agent, AgentReporter, AgentTask } from "./agents/types.js";
import type { HandInTask, TaskGithub } from "./github.js";
import { createRedactor } from "./redact.js";
import { TURN_DONE } from "./slotRuns.js";
import { NO_PULL_REQUEST, SlotPool, fitBytes } from "./slots.js";
import {
  ANSWER,
  DEFAULT_PROFILE,
  FIRST,
  FROM_ANSWER_MS,
  REPO,
  SECOND,
  START,
  STEP_MS,
  TIMEOUT_MS,
  TO_WAIT_MS,
  asked,
  fixture,
  pool,
  runScript,
  settle,
  slot,
  useSlotFixture,
  workEvents,
  workspaces,
} from "./slotPoolFixture.js";

describe("SlotPool", () => {
  useSlotFixture();

  it("starts with every slot idle, its agent named and titled by its default profile", () => {
    expect(FIRST).not.toBe(SECOND);
    expect(pool().report()).toEqual([
      { id: "slot-1", name: FIRST, ...DEFAULT_PROFILE, status: "idle", issueNumber: undefined, activity: "", pr: undefined },
      { id: "slot-2", name: SECOND, ...DEFAULT_PROFILE, status: "idle", issueNumber: undefined, activity: "", pr: undefined },
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
    expect(workEvents(slots)).toEqual([
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
    expect(workEvents(slots).map((event) => event.kind)).toEqual(["started"]);

    // A prompt is the answer, and it carries on.
    slots.handle(ANSWER);
    expect(slot(slots)).toMatchObject({ status: "working", activity: "Go ahead." });
    await vi.advanceTimersByTimeAsync(STEP_MS);
    expect(slot(slots)).toMatchObject({ status: "working", activity: "Bash: pnpm test" });

    await vi.advanceTimersByTimeAsync(STEP_MS);
    expect(slot(slots)).toMatchObject({ status: "idle", issueNumber: undefined, activity: "" });
    expect(workEvents(slots).map((event) => event.kind)).toEqual(["started", "failed"]);
    expect(workEvents(slots)[1]?.message).toMatch(/always fails/);
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
    expect(workEvents(slots).map((event) => event.message)).toEqual([
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
    expect(workEvents(slots)[1]?.message).toMatch(/^Bash: git commit failed: fatal: not a git repository/);
  });

  it("never commits in a repository above its workspace", async () => {
    // A workspace that lost its own repository, inside someone else's.
    const workdir = join(fixture.developer, "kept");
    mkdirSync(workdir);
    const head = fixture.git(fixture.developer, "rev-parse", "HEAD");
    const slots = pool("failed", undefined, { open: async () => workdir, close: async () => undefined });
    slots.handle(START);
    await vi.advanceTimersByTimeAsync(STEP_MS * 3);
    expect(workEvents(slots)[1]?.message).toMatch(/^Bash: git commit failed: fatal: not a git repository/);
    expect(fixture.git(fixture.developer, "rev-parse", "HEAD")).toBe(head);
    expect(fixture.git(fixture.developer, "status", "--porcelain")).toBe("?? kept/");
  });

  it("hands the agent its workspace as its working directory", async () => {
    const tasks: AgentTask[] = [];
    const spy: Agent = {
      label: "Spy",
      start: (task) => {
        tasks.push(task);
        return { stop: () => Promise.resolve() };
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
        systemPrompt: systemPrompt(defaultAgentProfile("runner", 0)),
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
    expect(workEvents(slots)).toEqual([
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
    expect(workEvents(slots).map((event) => event.message)).toEqual(["Stopped: the server asked"]);
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
      `start for slot-1 on #40 refused: ${FIRST} is busy with #39`,
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
      agent: { label: "Spy", start: () => ({ stop: () => Promise.resolve() }) },
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
    expect(workEvents(slots)[1]).toEqual({
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
    expect(workEvents(slots)).toHaveLength(2);
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
    expect(workEvents(slots).map((event) => [event.kind, event.pr?.number])).toEqual([
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
    expect(workEvents(slots).at(-1)).toMatchObject({ kind: "failed", message: "Stopped: the work is done" });
    await settle();
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
    slots.delivered(new Set(workEvents(slots).map((event) => event.id)));
    slots.handle({ ...START, id: "command-2" });
    expect(workEvents(slots).map((event) => [event.kind, event.pr?.number])).toEqual([
      ["started", undefined],
      ["pr-opened", 1_000_039],
    ]);
    expect(slot(slots)).toMatchObject({ status: "idle", issueNumber: 39, activity: TURN_DONE });
  });

  it("refuses an issue GitHub says may not be worked, before it opens a workspace", async () => {
    const start = vi.fn();
    const slots = pool("failed", { label: "Spy", start }, workspaces(), {
      refusal: async () => "#39 is labelled agent-restricted on GitHub, so no agent may work it",
      pullRequest: async () => undefined,
      pullRequestTitle: async () => "",
      discard: async () => undefined,
    });
    slots.handle(START);
    await settle();
    expect(start).not.toHaveBeenCalled();
    expect(slot(slots)).toMatchObject({ status: "idle", issueNumber: undefined });
    expect(workEvents(slots)).toEqual([
      {
        id: "event-1",
        kind: "failed",
        slotId: "slot-1",
        issueNumber: 39,
        pr: undefined,
        message: "#39 is labelled agent-restricted on GitHub, so no agent may work it",
      },
    ]);
    expect(asked).toEqual(["close slot-1 #39"]);
  });

  it("finds the pull request a turn ended without reporting, and hands it in", async () => {
    let reporter: AgentReporter | undefined;
    const pullRequest = vi.fn(async (task: HandInTask) => {
      expect(task).toEqual({ issueNumber: 39, title: "Night shift", workdir: fixture.developer, requestedBy: "Dana", agentName: FIRST });
      return { number: 95, title: "Night shift", url: `https://github.com/${REPO}/pull/95` };
    });
    const agent: Agent = {
      label: "Claude",
      start: (_task, given) => {
        reporter = given;
        return { stop: () => Promise.resolve() };
      },
    };
    const slots = pool("failed", agent, workspaces(), { refusal: async () => undefined, pullRequest, pullRequestTitle: async () => "", discard: async () => undefined });
    slots.handle(START);
    await settle();
    reporter?.progress("Bash: git push");
    reporter?.turnDone();
    await settle();
    expect(pullRequest).toHaveBeenCalledTimes(1);
    expect(slot(slots)).toMatchObject({ status: "idle", issueNumber: 39, activity: TURN_DONE, pr: { number: 95 } });
    expect(workEvents(slots).map((event) => [event.kind, event.pr?.url])).toEqual([
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
        return { stop: () => Promise.resolve() };
      },
    };
    const slots = pool("failed", agent, workspaces(), {
      refusal: async () => undefined,
      pullRequest: async () => {
        throw new Error("gh: HTTP 401");
      },
      pullRequestTitle: async () => "",
      discard: async () => undefined,
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
    expect(workEvents(slots).filter((event) => event.kind === "pr-opened")).toHaveLength(1);
    expect(slot(slots)).toMatchObject({ status: "working", pr });
  });

  it("asks GitHub for the title of a pull request its agent reports without one", async () => {
    let reporter: AgentReporter | undefined;
    const agent: Agent = {
      label: "Claude",
      start: (_task, given) => {
        reporter = given;
        return { stop: () => Promise.resolve() };
      },
    };
    const pullRequestTitle = vi.fn(async () => "Night shift");
    const slots = pool("failed", agent, workspaces(), { refusal: async () => undefined, pullRequest: async () => undefined, pullRequestTitle, discard: async () => undefined });
    slots.handle(START);
    await settle();
    reporter?.progress("Bash: gh pr create");
    reporter?.prOpened({ number: 96, title: "", url: `https://github.com/${REPO}/pull/96` });
    await settle();
    expect(pullRequestTitle).toHaveBeenCalledWith(96);
    expect(workEvents(slots).find((event) => event.kind === "pr-opened")?.pr).toEqual({
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
        return { stop: () => Promise.resolve() };
      },
    };
    let giveTitle: (title: string) => void = () => undefined;
    const pullRequest = vi.fn(async () => undefined);
    const pullRequestTitle = vi.fn(() => new Promise<string>((resolve) => (giveTitle = resolve)));
    const slots = pool("failed", agent, workspaces(), { refusal: async () => undefined, pullRequest, pullRequestTitle, discard: async () => undefined });
    slots.handle(START);
    await settle();
    reporter?.progress("Bash: gh pr create");
    reporter?.prOpened({ number: 96, title: "", url: `https://github.com/${REPO}/pull/96` });
    reporter?.turnDone();
    await settle();
    expect(pullRequest).not.toHaveBeenCalled();
    expect(slot(slots)).toMatchObject({ status: "idle", activity: TURN_DONE });
    expect(workEvents(slots).filter((event) => event.kind === "pr-opened")).toHaveLength(0);

    giveTitle("Night shift");
    await settle();
    expect(slot(slots)).toMatchObject({ status: "idle", pr: { number: 96, title: "Night shift" } });
    expect(workEvents(slots).filter((event) => event.kind === "pr-opened").map((event) => event.pr?.title)).toEqual(["Night shift"]);
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
    expect(workEvents(slots).map((event) => [event.kind, event.message])).toEqual([
      ["started", ""],
      ["failed", "Stopped: CEO changed their mind"],
    ]);
  });

  it("discards a cancelled task: its pull request and branch on GitHub first, then its worktree whatever is in it", async () => {
    const discard = vi.fn(async (branch: string) => {
      asked.push(`discard ${branch}`);
      return undefined;
    });
    const github: TaskGithub = { refusal: async () => undefined, pullRequest: async () => undefined, pullRequestTitle: async () => "", discard };
    const slots = pool("pr-opened", undefined, workspaces(), github);
    slots.handle(START);
    await vi.advanceTimersByTimeAsync(STEP_MS * 2);
    slots.handle({ id: "command-2", slotId: "slot-1", kind: "stop", reason: "the CEO cancelled the task", issueNumber: 39, discard: true });
    await settle();
    expect(slot(slots)).toMatchObject({ status: "idle", issueNumber: undefined });
    expect(asked).toEqual(["open slot-1 #39", "discard sims/issue-39-slot-1", "close slot-1 #39 discarding"]);
    expect(workEvents(slots).at(-1)).toMatchObject({ kind: "failed", message: "Stopped: the CEO cancelled the task" });
  });

  it("keeps a stop, discarding or not, off work the slot moved on to, discarding only what it kept of the cancelled issue", async () => {
    const slots = pool("pr-opened");
    slots.handle(START);
    await settle();
    slots.handle({ id: "command-2", slotId: "slot-1", kind: "stop", reason: "", issueNumber: 40 });
    slots.handle({ id: "command-3", slotId: "slot-1", kind: "stop", reason: "cancelled", issueNumber: 40, discard: true });
    await settle();
    expect(slot(slots)?.issueNumber).toBe(39);
    expect(asked).toEqual(["open slot-1 #39", "close slot-1 #40 discarding"]);
  });

  it("discards a cancelled task whose run had already ended, so its kept work does not come back", async () => {
    const discard = vi.fn(async () => undefined);
    const github: TaskGithub = { refusal: async () => undefined, pullRequest: async () => undefined, pullRequestTitle: async () => "", discard };
    const stalled: Agent = { label: "Stuck", start: () => ({ stop: vi.fn(() => Promise.resolve()) }) };
    const slots = pool("failed", stalled, workspaces(), github);
    slots.handle(START);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(asked).toEqual(["open slot-1 #39", "close slot-1 #39"]);
    slots.handle({ id: "command-2", slotId: "slot-1", kind: "stop", reason: "the CEO cancelled the task", issueNumber: 39, discard: true });
    await settle();
    expect(discard).toHaveBeenCalledWith("sims/issue-39-slot-1", fixture.developer);
    expect(asked).toEqual(["open slot-1 #39", "close slot-1 #39", "close slot-1 #39 discarding"]);
  });

  it("discards the cancelled task of an agent fired while idle", async () => {
    const slots = pool();
    slots.handle({ id: "command-2", slotId: "slot-1", kind: "fire", requestedBy: "Dana" });
    slots.handle({ id: "command-3", slotId: "slot-1", kind: "stop", reason: "the CEO cancelled the task", issueNumber: 39, discard: true });
    slots.handle({ id: "command-4", slotId: "slot-1", kind: "stop", reason: "", issueNumber: 40 });
    await settle();
    expect(asked).toEqual(["close slot-1 #39 discarding"]);
  });

  it("fires a slot: its task ends discarded, and the slot is reported no more and takes no command", async () => {
    const slots = pool("pr-opened");
    slots.handle(START);
    await vi.advanceTimersByTimeAsync(STEP_MS * 2);
    slots.handle({ id: "command-2", slotId: "slot-1", kind: "fire", requestedBy: "Dana" });
    await settle();
    expect(slots.report().map((each) => each.id)).toEqual(["slot-2"]);
    expect(slots.screens().map(([id]) => id)).toEqual(["slot-2"]);
    expect(slots.freeForStanding()).toEqual(["slot-2"]);
    expect(asked).toEqual(["open slot-1 #39", "close slot-1 #39 discarding"]);
    expect(workEvents(slots).at(-1)).toMatchObject({ kind: "failed", slotId: "slot-1", message: "Fired by Dana" });
    slots.handle({ ...START, id: "command-3" });
    await settle();
    expect(asked).toEqual(["open slot-1 #39", "close slot-1 #39 discarding"]);
  });

  it("keeps a fired slot out of the pool when the runner starts again", () => {
    let kept: ReadonlySet<string> = new Set();
    const fired = { load: () => kept, save: (ids: ReadonlySet<string>) => (kept = new Set(ids)) };
    const options = { count: 2, agent: createMockAgent({ outcome: "failed", stepMs: STEP_MS }), workspaces: workspaces(), taskTimeoutMs: TIMEOUT_MS, fired };
    new SlotPool(options).handle({ id: "command-1", slotId: "slot-1", kind: "fire", requestedBy: "Dana" });
    expect(kept).toEqual(new Set(["slot-1"]));
    const restarted = new SlotPool(options);
    expect(restarted.report().map((each) => [each.id, each.name])).toEqual([["slot-2", SECOND]]);
  });

  describe("hiring", () => {
    const NOVA = { name: "Nova", title: "Accessibility Specialist", description: "Makes the HUD work from the keyboard." };
    const HIRE = { id: "command-hire", slotId: "hired-1", kind: "hire", ...NOVA, requestedBy: "Dana" } as const;

    function memory() {
      let ids: ReadonlySet<string> = new Set();
      let profiles: ReadonlyMap<string, AgentProfile> = new Map();
      return {
        hired: { load: () => ids, save: (next: ReadonlySet<string>) => (ids = new Set(next)) },
        fired: (() => {
          let fired: ReadonlySet<string> = new Set();
          return { load: () => fired, save: (next: ReadonlySet<string>) => (fired = new Set(next)) };
        })(),
        profiles: { load: () => profiles, save: (next: ReadonlyMap<string, AgentProfile>) => (profiles = new Map(next)) },
        ids: () => ids,
      };
    }

    function hiringPool(stores: ReturnType<typeof memory>, count = 2) {
      return new SlotPool({
        count,
        agent: createMockAgent({ outcome: "failed", stepMs: STEP_MS }),
        workspaces: workspaces(),
        taskTimeoutMs: TIMEOUT_MS,
        hired: stores.hired,
        fired: stores.fired,
        profiles: stores.profiles,
      });
    }

    it("adds the hired agent's slot with its profile, idle, and takes its task as any slot's", async () => {
      const stores = memory();
      const slots = hiringPool(stores);
      slots.handle(HIRE);
      expect(slots.report().map((each) => each.id)).toEqual(["slot-1", "slot-2", "hired-1"]);
      expect(slot(slots, "hired-1")).toMatchObject({ ...NOVA, status: "idle" });
      expect(stores.ids()).toEqual(new Set(["hired-1"]));
      slots.handle({ ...START, id: "command-start", slotId: "hired-1" });
      await settle();
      expect(asked).toEqual(["open hired-1 #39"]);
    });

    it("brings hired agents back, with their profiles, when the runner starts again, unless they were fired", () => {
      const stores = memory();
      const first = hiringPool(stores);
      first.handle(HIRE);
      first.handle({ ...HIRE, id: "command-hire-2", slotId: "hired-2", name: "Orla" });
      first.handle({ id: "command-fire", slotId: "hired-2", kind: "fire", requestedBy: "Dana" });
      expect(stores.ids()).toEqual(new Set(["hired-1"]));
      const restarted = hiringPool(stores);
      expect(restarted.report().map((each) => [each.id, each.name])).toEqual([
        ["slot-1", FIRST],
        ["slot-2", SECOND],
        ["hired-1", "Nova"],
      ]);
      restarted.handle({ ...HIRE, id: "command-hire-3", slotId: "hired-2" });
      expect(restarted.report()).toHaveLength(3);
    });

    it("takes no hire past the slots the server takes, nor one for a slot it has", () => {
      const stores = memory();
      const slots = hiringPool(stores, 3);
      slots.handle({ ...HIRE, slotId: "slot-1" });
      slots.handle(HIRE);
      slots.handle({ ...HIRE, id: "command-hire-2", slotId: "hired-2" });
      expect(slots.report().map((each) => each.id)).toEqual(["slot-1", "slot-2", "slot-3", "hired-1"]);
      expect(slot(slots, "slot-1")?.name).toBe(FIRST);
    });
  });

  it("fires an idle slot, which had nothing to discard", () => {
    const slots = pool();
    slots.handle({ id: "command-2", slotId: "slot-2", kind: "fire", requestedBy: "Dana" });
    expect(slots.report().map((each) => each.id)).toEqual(["slot-1"]);
    expect(workEvents(slots)).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("ignores a stop for an idle slot", () => {
    const slots = pool();
    slots.handle({ id: "command-2", slotId: "slot-1", kind: "stop", reason: "" });
    expect(workEvents(slots)).toEqual([]);
  });

  it("refuses a start on a busy slot without disturbing its work", () => {
    const slots = pool();
    slots.handle(START);
    slots.handle({ ...START, id: "command-2", issueNumber: 40 });
    expect(slot(slots)?.issueNumber).toBe(39);
    expect(workEvents(slots)).toEqual([
      { id: "event-1", kind: "failed", slotId: "slot-1", issueNumber: 40, pr: undefined, message: `${FIRST} is busy with #39` },
    ]);
  });

  it("stops work that runs past the task timeout", async () => {
    const stalled: Agent = { label: "Stuck", start: () => ({ stop: vi.fn(() => Promise.resolve()) }) };
    const slots = pool("failed", stalled);
    slots.handle(START);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(slot(slots)?.status).toBe("idle");
    expect(workEvents(slots)[0]).toMatchObject({ kind: "failed", message: "Timed out after 1 minute" });
  });

  it("holds the task timeout while its agent waits on a person, and counts on from there once it works again", async () => {
    let reporter: AgentReporter | undefined;
    const agent: Agent = {
      label: "Asker",
      start: (_task, given) => {
        reporter = given;
        return { stop: () => Promise.resolve() };
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
    expect(workEvents(slots).map((event) => event.kind)).toEqual(["started"]);

    reporter?.progress("Bash: git push");
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 0.6 - 1);
    expect(slot(slots)).toMatchObject({ status: "working", issueNumber: 39 });
    await vi.advanceTimersByTimeAsync(1);
    expect(slot(slots)).toMatchObject({ status: "idle", issueNumber: undefined });
    expect(workEvents(slots).at(-1)).toMatchObject({ kind: "failed", message: "Timed out after 1 minute" });
  });

  it("stops every run as the runner shuts down", () => {
    const slots = pool();
    slots.handle(START);
    slots.handle({ ...START, id: "command-2", slotId: "slot-2", issueNumber: 40 });
    slots.stopAll();
    expect(slots.report().every((report) => report.status === "idle")).toBe(true);
    expect(workEvents(slots).map((event) => [event.slotId, event.message])).toEqual([
      ["slot-1", "Stopped: the runner shut down"],
      ["slot-2", "Stopped: the runner shut down"],
    ]);
  });

  it("gives up a stopped run's worktree only once its agent has exited, and waits for that as it shuts down", async () => {
    let exit = (): void => undefined;
    const slow: Agent = {
      label: "Slow",
      start: () => ({ stop: () => new Promise<void>((resolve) => (exit = resolve)) }),
    };
    const slots = pool("failed", slow);
    slots.handle(START);
    await settle();
    let stopped = false;
    void slots.stopAll().then(() => (stopped = true));
    await settle();
    expect(asked).toEqual(["open slot-1 #39"]);
    expect(stopped).toBe(false);

    exit();
    await settle();
    expect(asked).toEqual(["open slot-1 #39", "close slot-1 #39"]);
    expect(stopped).toBe(true);
  });

  it("opens a restarted run's worktree only once the stopped run on its slot has exited and given its worktree up", async () => {
    const exits: Array<() => void> = [];
    const slow: Agent = {
      label: "Slow",
      start: () => ({ stop: () => new Promise<void>((resolve) => exits.push(resolve)) }),
    };
    const slots = pool("failed", slow);
    slots.handle(START);
    await settle();
    slots.handle({ id: "command-2", slotId: "slot-1", kind: "stop", reason: "" });
    slots.handle({ ...START, id: "command-3" });
    await settle();
    expect(asked).toEqual(["open slot-1 #39"]);

    exits[0]?.();
    await settle();
    expect(asked).toEqual(["open slot-1 #39", "close slot-1 #39", "open slot-1 #39"]);
  });

  it("still waits for the first stopped run's exit when a restart is stopped again before it opens", async () => {
    const exits: Array<() => void> = [];
    const slow: Agent = {
      label: "Slow",
      start: () => ({ stop: () => new Promise<void>((resolve) => exits.push(resolve)) }),
    };
    const slots = pool("failed", slow);
    slots.handle(START);
    await settle();
    slots.handle({ id: "command-2", slotId: "slot-1", kind: "stop", reason: "" });
    slots.handle({ ...START, id: "command-3" });
    await settle();
    slots.handle({ id: "command-4", slotId: "slot-1", kind: "stop", reason: "" });
    slots.handle({ ...START, id: "command-5" });
    await settle();
    expect(asked).toEqual(["open slot-1 #39"]);

    exits[0]?.();
    await settle();
    expect(asked).toEqual(["open slot-1 #39", "close slot-1 #39", "close slot-1 #39", "open slot-1 #39"]);
  });

  it("discards a cancelled task's worktree only once its stopped agent has exited", async () => {
    const exits: Array<() => void> = [];
    const slow: Agent = {
      label: "Slow",
      start: () => ({ stop: () => new Promise<void>((resolve) => exits.push(resolve)) }),
    };
    const slots = pool("failed", slow);
    slots.handle(START);
    await settle();
    slots.handle({ id: "command-2", slotId: "slot-1", kind: "stop", reason: "" });
    slots.handle({ id: "command-3", slotId: "slot-1", kind: "stop", reason: "", issueNumber: 39, discard: true });
    await settle();
    expect(asked).toEqual(["open slot-1 #39"]);

    exits[0]?.();
    await settle();
    expect(asked).toEqual(["open slot-1 #39", "close slot-1 #39", "close slot-1 #39 discarding"]);
  });

  it("ignores a command for a slot it does not have, and a prompt for a slot holding no task", () => {
    const slots = pool();
    slots.handle({ ...START, slotId: "slot-9" });
    slots.handle({ id: "command-2", slotId: "slot-1", kind: "prompt", text: "hurry", requestedBy: "Dana" });
    expect(slots.report().every((report) => report.status === "idle")).toBe(true);
    expect(workEvents(slots)).toEqual([]);
  });

  it("forgets only the events a sync delivered", async () => {
    const slots = pool();
    slots.handle(START);
    await runScript(slots);
    slots.delivered(new Set(["event-1"]));
    expect(workEvents(slots).map((event) => event.id)).toEqual(["event-2"]);
  });

  it("cuts what an agent says to the contract's budgets", async () => {
    const chatty: Agent = {
      label: "A label far too long for a name",
      start: (_task, reporter) => {
        reporter.started();
        reporter.progress("é".repeat(200));
        waiting = () => reporter.needsInput("ü".repeat(200));
        return { stop: () => Promise.resolve() };
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
        return { stop: () => Promise.resolve() };
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
    expect(workEvents(slots).map((event) => [event.kind, event.message])).toEqual([
      ["started", ""],
      ["finished", "Claude exited with code 0"],
    ]);
    await settle();
    expect(asked).toEqual(["open slot-1 #39", "close slot-1 #39"]);
  });

  it("reports started once, whatever an agent says first, and an exit with an error as failed", async () => {
    let reporter: AgentReporter | undefined;
    const agent: Agent = {
      label: "Claude",
      start: (_task, given) => {
        reporter = given;
        return { stop: () => Promise.resolve() };
      },
    };
    const slots = pool("failed", agent);
    slots.handle(START);
    await settle();
    reporter?.needsInput("Claude isn't signed in");
    reporter?.started();
    reporter?.exited("Claude exited with code 1", false);
    expect(workEvents(slots).map((event) => [event.kind, event.message])).toEqual([
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
        return { stop: () => Promise.resolve() };
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
    const messages = workEvents(slots).map((event) => event.message);
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
        return { stop: () => Promise.resolve() };
      },
    };
    const slots = pool("failed", agent);
    slots.handle(START);
    await settle();
    slots.handle({ id: "command-2", slotId: "slot-1", kind: "stop", reason: "" });
    expect(late).toBeDefined();
    late?.();
    expect(slot(slots)?.status).toBe("idle");
    expect(workEvents(slots)).toHaveLength(1);
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
