/**
 * The server's side of standing tasks: the mirror every room reads, the one
 * gate every action goes through, the runner link's commands for them, and
 * what the AI Manager says of each run.
 */

import { MapSchema } from "@colyseus/schema";
import {
  type RunnerStandingRunEvent,
  type RunnerSync,
  STANDING_OFF,
  STANDING_REJECTION,
  StandingTask,
  type StandingTaskReport,
  liveAgentKey,
} from "@sim/shared";
import { describe, expect, it } from "vitest";

import { RunnerLink, runnerSlotAgentId } from "./runnerLink.js";
import { StandingAnnouncer } from "./standingAnnouncer.js";
import { StandingControl } from "./standingControl.js";
import { StandingMirror, copyStandingTasks } from "./standingMirror.js";

const REPO = "krasovsky22/agent-office-sims";
const CEO = { id: "ceo", kind: "human", isCeo: true } as const;
const EXEC = { id: "exec", kind: "human", isCeo: false } as const;

function report(id: string, extra: Partial<StandingTaskReport> = {}): StandingTaskReport {
  return {
    id,
    kind: "pr-review",
    name: "Watch for new pull requests",
    status: "active",
    trigger: "every 2 min",
    lastCheckAt: 1,
    nextCheckAt: 2,
    queued: 0,
    handledToday: 0,
    spentTodayUsd: 0,
    dailyUsd: 2,
    lastError: "",
    recent: [],
    ...extra,
  };
}

function sync(runnerId: string, extra: Partial<RunnerSync> = {}): RunnerSync {
  return { runnerId, repo: REPO, acked: [], slots: [{ id: "slot-1", name: "Mock 1", status: "idle", issueNumber: undefined, activity: "", pr: undefined }], events: [], ...extra };
}

function setup(now = () => 1000) {
  const mirror = new StandingMirror({ now });
  let id = 0;
  const link = new RunnerLink({ repository: REPO, timeoutMs: 10_000, standing: mirror, now, commandId: () => `c${(id += 1)}`, pullTitle: (number) => (number === 112 ? "Add a lift" : undefined) });
  let task = 0;
  const control = new StandingControl({ directory: mirror, commands: link, taskId: () => `st-task${(task += 1)}` });
  return { mirror, link, control };
}

describe("StandingControl", () => {
  it("is the CEO's alone", () => {
    const { control, link } = setup();
    link.sync(sync("box"));
    expect(control.create(EXEC, "Eve", { kind: "pr-review" }, "")).toMatchObject({ ok: false, rejection: STANDING_REJECTION.forbidden });
    expect(control.act(EXEC, "Eve", "pause", "st-task1")).toMatchObject({ ok: false, rejection: STANDING_REJECTION.forbidden });
    expect(link.pending("box")).toEqual([]);
  });

  it("sets the pull request watch up on a runner that takes it, once", () => {
    const { control, link } = setup();
    link.sync(sync("box"));
    const created = control.create(CEO, "Dana", { kind: "pr-review" }, "");
    expect(created).toMatchObject({ ok: true, taskId: "st-task1", text: expect.stringContaining("“Watch for new pull requests” is set up on box") });
    expect(link.pending("box")).toEqual([
      {
        id: "c1",
        kind: "standing-set",
        requestedBy: "Dana",
        spec: expect.objectContaining({ id: "st-task1", kind: "pr-review", intervalSeconds: 120, authors: "collaborators", caps: { perRunUsd: 0.5, runMinutes: 10, dailyUsd: 2, maxRunsPerHour: 6 } }),
      },
    ]);
    // Asked for again before the runner has even reported it: still the one watch.
    expect(control.create(CEO, "Dana", { kind: "pr-review" }, "")).toMatchObject({ ok: false, rejection: STANDING_REJECTION.duplicate });
  });

  it("says why when no runner can take one", () => {
    const { control, link } = setup();
    expect(control.create(CEO, "Dana", { kind: "pr-review" }, "")).toMatchObject({ ok: false, rejection: STANDING_REJECTION.noRunner });
    link.sync(sync("box", { standingOff: STANDING_OFF.noBudget }));
    const refused = control.create(CEO, "Dana", { kind: "pr-review" }, "");
    expect(refused).toMatchObject({ ok: false, rejection: STANDING_REJECTION.runnerRefuses, text: expect.stringContaining("RUNNER_STANDING_DAILY_BUDGET_USD") });
    expect(link.pending("box")).toEqual([]);
  });

  it("refuses a schedule firing too often, and a fifth task", () => {
    const { control, link } = setup();
    expect(control.create(CEO, "Dana", { kind: "schedule", cron: "* * * * *", instruction: "Spin." }, "")).toMatchObject({
      ok: false,
      rejection: STANDING_REJECTION.invalid,
      text: expect.stringContaining("more often than every 5 minutes"),
    });
    link.sync(sync("box", { standing: [report("st-a1b2"), report("st-c3d4", { kind: "schedule" }), report("st-e5f6", { kind: "schedule" }), report("st-g7h8", { kind: "schedule" })] }));
    expect(control.create(CEO, "Dana", { kind: "schedule", cron: "0 9 * * *", instruction: "Sum up." }, "")).toMatchObject({ ok: false, rejection: STANDING_REJECTION.full });
  });

  it("schedules a job, and acts on a task it holds", () => {
    const { control, link } = setup();
    link.sync(sync("box"));
    const scheduled = control.create(CEO, "Dana", { kind: "schedule", cron: "0 9 * * 1-5", instruction: "Summarise what changed." }, "");
    expect(scheduled).toMatchObject({ ok: true, text: expect.stringContaining("Scheduled “Summarise what changed.” on box: weekdays 09:00") });
    link.sync(sync("box", { acked: ["c1"], standing: [report("st-task1", { kind: "schedule", name: "Summarise what changed." })] }));
    expect(control.act(CEO, "Dana", "check-now", "st-task1")).toMatchObject({ ok: true, text: "✓ “Summarise what changed.” runs now." });
    expect(control.act(CEO, "Dana", "pause", "st-nothing")).toMatchObject({ ok: false, rejection: STANDING_REJECTION.unknownTask });
    expect(link.pending("box")).toEqual([{ id: "c2", kind: "standing-check-now", taskId: "st-task1", requestedBy: "Dana" }]);
  });
});

describe("StandingControl on a runner off for standing tasks", () => {
  it("refuses to resume or check a task it kept, and still pauses and removes it", () => {
    const { control, link } = setup();
    link.sync(sync("box", { standingOff: STANDING_OFF.noBudget, standing: [report("st-kept", { kind: "schedule", name: "Morning summary", status: "error" })] }));
    for (const action of ["check-now", "resume"] as const) {
      expect(control.act(CEO, "Dana", action, "st-kept")).toMatchObject({ ok: false, rejection: STANDING_REJECTION.runnerRefuses, text: expect.stringContaining("RUNNER_STANDING_DAILY_BUDGET_USD") });
    }
    expect(link.pending("box")).toEqual([]);
    expect(control.act(CEO, "Dana", "pause", "st-kept")).toMatchObject({ ok: true });
    expect(control.act(CEO, "Dana", "remove", "st-kept")).toMatchObject({ ok: true });
    expect(link.pending("box").map((command) => command.kind)).toEqual(["standing-pause", "standing-remove"]);
  });
});

describe("the standing mirror", () => {
  it("keeps every runner's tasks with the slot running each, and drops a runner's with it", () => {
    let clock = 1000;
    const { mirror, link } = setup(() => clock);
    link.sync(
      sync("box", {
        slots: [{ id: "slot-1", name: "Mock 1", status: "working", issueNumber: undefined, activity: "Reviewing PR #112", pr: undefined, standing: { taskId: "st-abcd", pr: 112 } }],
        standing: [report("st-abcd", { status: "running" })],
      }),
    );
    const version = mirror.standingVersion();
    expect(mirror.standingTasks()).toEqual([{ runnerId: "box", report: report("st-abcd", { status: "running" }), runningAgentId: liveAgentKey(runnerSlotAgentId("box", "slot-1")) }]);
    // The slot is on the floor with the pull request it reviews.
    expect(link.current()[0]?.task).toEqual({ title: "Review PR #112: Add a lift", url: `https://github.com/${REPO}/pull/112` });

    link.sync(sync("box", { slots: [{ id: "slot-1", name: "Mock 1", status: "working", issueNumber: undefined, activity: "x", pr: undefined, standing: { taskId: "st-abcd", pr: 112 } }], standing: [report("st-abcd", { status: "running" })] }));
    expect(mirror.standingVersion()).toBe(version);

    clock += 20_000;
    link.sweep();
    expect(mirror.standingTasks()).toEqual([]);
    expect(mirror.standingVersion()).toBe(version + 1);
  });

  it("copies into a room's state field by field, and removes what is gone", () => {
    const map = new MapSchema<StandingTask>();
    copyStandingTasks(map, [{ runnerId: "box", report: report("st-abcd", { recent: [{ at: 5, outcome: "simulated", pr: 112 }] }), runningAgentId: undefined }]);
    expect(map.get("st-abcd")).toMatchObject({ runnerId: "box", status: "active", lastOutcome: "simulated", lastRunPr: 112, runningAgentId: "", nextCheckAt: 2 });
    copyStandingTasks(map, []);
    expect(map.size).toBe(0);
  });
});

describe("StandingAnnouncer", () => {
  const said: string[] = [];
  const announcer = new StandingAnnouncer({
    pullUrl: (number) => `https://github.com/${REPO}/pull/${number}`,
    taskName: (taskId) => (taskId === "st-abcd" ? "Watch for new pull requests" : undefined),
    occupantName: (id) => (id === liveAgentKey(runnerSlotAgentId("box", "slot-2")) ? "Claude 2" : undefined),
    announce: (text) => said.push(text),
  });
  const run = (extra: Partial<RunnerStandingRunEvent>): RunnerStandingRunEvent => ({
    id: "e",
    kind: "standing-run",
    taskId: "st-abcd",
    slotId: "slot-2",
    pr: { number: 112, title: "Add a lift" },
    outcome: "reviewed",
    commentId: 99,
    costUsd: 0.12,
    message: "",
    final: false,
    ...extra,
  });

  it("links a posted review, and says a simulated one posted nothing", () => {
    expect(announcer.runText("box", run({}))).toBe(`Claude 2 reviewed PR #112 “Add a lift”: https://github.com/${REPO}/pull/112#issuecomment-99`);
    expect(announcer.runText("box", run({ outcome: "simulated", commentId: undefined }))).toBe(
      "Claude 2 did a simulated review of PR #112 “Add a lift” for “Watch for new pull requests”; nothing was posted on GitHub.",
    );
  });

  it("says a failure once, after its last attempt, and a scheduled run's result", () => {
    expect(announcer.runText("box", run({ outcome: "failed", message: "The review stopped." }))).toBeUndefined();
    expect(announcer.runText("box", run({ outcome: "failed", final: true, message: "The review stopped." }))).toBe(
      "“Watch for new pull requests” couldn't review PR #112 “Add a lift” after its last try: the review stopped.",
    );
    expect(announcer.runText("box", run({ taskId: "st-other", pr: undefined, outcome: "completed", message: "3 issues opened." }))).toBe(
      "Claude 2 ran “a standing task” ($0.12):\n3 issues opened.",
    );
  });

  it("passes issue work's events over, and says a refusal", () => {
    said.length = 0;
    announcer.receive([
      { runnerId: "box", event: { id: "x", kind: "started", slotId: "slot-1", issueNumber: 39, pr: undefined, message: "" } },
      { runnerId: "box", event: { id: "y", kind: "standing-refused", taskId: "st-abcd", name: "Watch for new pull requests", message: "No budget" } },
    ]);
    expect(said).toEqual(["The runner wouldn't take “Watch for new pull requests”: no budget"]);
  });
});
