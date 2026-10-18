/**
 * What the AI Manager makes of the CEO's words about standing tasks: the
 * pull request watch, schedules read into cron, the CEO's buttons by name,
 * and the list; and how a plan about them is carried out through the gate.
 */

import { describe, expect, it } from "vitest";

import type { StandingControl } from "../agents/standingControl.js";
import { planFromRules } from "./rulePlanner.js";
import type { OfficeView, StandingTaskView } from "./officeView.js";
import { carryOutStanding, readSchedule, resolveStandingTask, standingSummary } from "./standingPlan.js";

function task(extra: Partial<StandingTaskView>): StandingTaskView {
  return {
    id: "st-watch01",
    kind: "pr-review",
    name: "Watch for new pull requests",
    status: "active",
    trigger: "every 2 min",
    lastOutcome: "simulated",
    lastRunPr: 112,
    queued: 1,
    spentTodayUsd: 0.2,
    dailyUsd: 2,
    lastError: undefined,
    runningOn: undefined,
    ...extra,
  };
}

const VIEW: OfficeView = {
  ceo: "Dana",
  liveAgents: [],
  issueAgents: [],
  work: [],
  project: undefined,
  orchestrator: false,
  standing: [task({}), task({ id: "st-morning", kind: "schedule", name: "Morning summary", trigger: "weekdays 09:00", lastOutcome: undefined, lastRunPr: undefined, queued: 0 })],
};

function ask(message: string, view = VIEW) {
  return planFromRules({ message, ceoName: "Dana", view, history: [] });
}

describe("readSchedule", () => {
  it("reads the common ways to say a schedule, at the start or the end", () => {
    expect(readSchedule("Every weekday at 9, summarise what changed yesterday.")).toEqual({ cron: "0 9 * * 1-5", instruction: "summarise what changed yesterday." });
    expect(readSchedule("every 30 minutes check the open issues for anything urgent")).toEqual({ cron: "*/30 * * * *", instruction: "check the open issues for anything urgent" });
    expect(readSchedule("schedule a job every day at 5:30pm to list open PRs")).toEqual({ cron: "30 17 * * *", instruction: "list open PRs" });
    expect(readSchedule("Summarise open PRs every Monday at 9am")).toEqual({ cron: "0 9 * * 1", instruction: "Summarise open PRs" });
    expect(readSchedule("daily at noon: post the board's counts")).toEqual({ cron: "0 12 * * *", instruction: "post the board's counts" });
    expect(readSchedule("every 2 hours look at CI")).toEqual({ cron: "0 */2 * * *", instruction: "look at CI" });
    expect(readSchedule("hourly, look at CI")).toEqual({ cron: "0 * * * *", instruction: "look at CI" });
    expect(readSchedule("on cron 15 8 * * 1-5 run the triage")).toEqual({ cron: "15 8 * * 1-5", instruction: "run the triage" });
    expect(readSchedule("every weekend at 10 tidy the labels")).toEqual({ cron: "0 10 * * 0,6", instruction: "tidy the labels" });
  });

  it("finds no schedule where there is none", () => {
    expect(readSchedule("summarise what changed")).toBeUndefined();
    expect(readSchedule("put someone on #12")).toBeUndefined();
  });
});

describe("planFromRules: standing tasks", () => {
  it("sets up the pull request watch", () => {
    for (const said of ["watch for new pull requests", "Please review new pull requests.", "keep watching for new PRs", "AI manager, watch for new PRs"]) {
      expect(ask(said)).toMatchObject({ assignments: [], standing: [{ action: "watch-pull-requests" }] });
    }
  });

  it("schedules a job, asks what it should do when it does not say, and refuses one too frequent", () => {
    expect(ask("every weekday at 9 summarise what changed").standing).toEqual([
      { action: "schedule", cron: "0 9 * * 1-5", instruction: "summarise what changed", name: "" },
    ]);
    expect(ask("every weekday at 9")).toMatchObject({ reply: expect.stringContaining("What should the job do") });
    expect(ask("every weekday at 9").standing).toBeUndefined();
    expect(ask("every minute check the board")).toMatchObject({ reply: expect.stringContaining("more often than every 5 minutes") });
    expect(ask("every minute check the board").standing).toBeUndefined();
  });

  it("pauses, resumes, removes and checks a task by what the CEO calls it", () => {
    expect(ask("pause the pull request watch").standing).toEqual([{ action: "pause", task: "the pull request watch" }]);
    expect(ask("resume the PR watch").standing).toEqual([{ action: "resume", task: "the pr watch" }]);
    expect(ask("stop watching pull requests").standing).toEqual([{ action: "remove", task: "pull requests" }]);
    expect(ask("remove the morning summary").standing).toEqual([{ action: "remove", task: "the morning summary" }]);
    expect(ask("run the morning summary now").standing).toEqual([{ action: "check-now", task: "the morning summary" }]);
    // Nothing standing by that name: not a standing instruction at all.
    expect(ask("pause the jumping ticket").standing).toBeUndefined();
  });

  it("lists what it watches, and never acts on a question", () => {
    const listed = ask("what are you watching?");
    expect(listed.standing).toBeUndefined();
    expect(listed.reply).toContain("“Watch for new pull requests” (every 2 min) · active; last: simulated PR #112; 1 waiting for a free coding agent; $0.20 of $2.00 today");
    expect(listed.reply).toContain("“Morning summary” (weekdays 09:00) · active");
    expect(ask("should I pause the pull request watch?").standing).toBeUndefined();
    expect(standingSummary({ ...VIEW, standing: [] })).toMatch(/^No standing tasks yet/);
  });
});

describe("carrying a standing plan out", () => {
  it("resolves what it names now, through the gate, saying what happened", () => {
    const calls: unknown[] = [];
    const control: Pick<StandingControl, "create" | "act"> = {
      create: (_actor, _name, request) => {
        calls.push(request);
        return { ok: true, taskId: "st-new1", text: "✓ set up" };
      },
      act: (_actor, _name, action, taskId) => {
        calls.push([action, taskId]);
        return { ok: false, rejection: "unreachable", text: "The runner could not be given that." };
      },
    };
    const lines = carryOutStanding(
      [
        { action: "watch-pull-requests" },
        { action: "pause", task: "pull requests" },
        { action: "remove", task: "the lunch rota" },
      ],
      { control, actor: { id: "ceo", kind: "human", isCeo: true }, ceoName: "Dana", view: VIEW },
    );
    expect(lines).toEqual(["✓ set up", "✗ The runner could not be given that.", "✗ I can't find a standing task called “the lunch rota”."]);
    expect(calls).toEqual([{ kind: "pr-review" }, ["pause", "st-watch01"]]);
    expect(resolveStandingTask("st-morning", VIEW)?.name).toBe("Morning summary");
  });
});
