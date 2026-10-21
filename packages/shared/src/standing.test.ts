/**
 * Standing tasks' contract: a definition is proved before a runner keeps it,
 * the CEO alone may manage one, and a sync carrying every task a runner may
 * hold still fits inside the route's body limit.
 */

import { describe, expect, it } from "vitest";

import { MAX_AGENT_DESCRIPTION_BYTES, MAX_AGENT_TITLE_BYTES } from "./agentProfile.js";
import { parseStandingCreateMessage } from "./messages.js";
import { OCCUPANT_KIND } from "./state.js";
import {
  MAX_RUNNER_ACKS,
  MAX_RUNNER_EVENTS,
  MAX_RUNNER_ANSWER_BYTES,
  MAX_RUNNER_PROMPT_OUTCOMES,
  MAX_RUNNER_SLOTS,
  MAX_RUNNER_ISSUE_STATE_OUTCOMES,
  MAX_RUNNER_SYNC_BYTES,
  RUNNER_COMMAND_KIND,
  type RunnerStandingRunEvent,
  parseRunnerSync,
  parseStandingRunRecord,
  toRunnerCommand,
} from "./runner.js";
import {
  DEFAULT_STANDING_CAPS,
  MAX_STANDING_LOG_BYTES,
  MAX_STANDING_MESSAGE_BYTES,
  MAX_STANDING_NAME_BYTES,
  MAX_STANDING_RECENT,
  MAX_STANDING_RESULT_BYTES,
  MAX_STANDING_SUMMARY_BYTES,
  MAX_STANDING_TASKS,
  MAX_STANDING_TRIGGER_BYTES,
  MAX_STANDING_ERROR_BYTES,
  PR_REVIEW_TASK_NAME,
  PR_STEWARD_TASK_NAME,
  type PullCheck,
  type PullState,
  STANDING_KIND,
  isStandingTaskId,
  mayManageStandingTasks,
  mergeGate,
  parseStandingSchedule,
  parseStandingTaskSpec,
  rescheduled,
  stewardStep,
} from "./standing.js";

const PR_REVIEW = {
  id: "st-abc123",
  kind: "pr-review",
  name: "",
  paused: false,
  note: "Be brief.",
  version: 1,
  caps: DEFAULT_STANDING_CAPS,
  intervalSeconds: 120,
  authors: "collaborators",
};

const STEWARD = {
  id: "st-steward1",
  kind: "pr-steward",
  name: "",
  paused: false,
  note: "",
  version: 1,
  caps: DEFAULT_STANDING_CAPS,
  intervalSeconds: 120,
  agent: "hired-1a2b3c4d",
};

const SCHEDULE = {
  id: "st-sched1",
  kind: "schedule",
  name: "Morning summary",
  paused: false,
  note: "",
  version: 2,
  caps: DEFAULT_STANDING_CAPS,
  cron: "0  9 * * 1-5",
  instruction: "Summarise what changed on main since yesterday.",
};

describe("parseStandingTaskSpec", () => {
  it("reads a pull request watch, naming it when nobody did", () => {
    expect(parseStandingTaskSpec(PR_REVIEW)).toEqual({ ...PR_REVIEW, name: PR_REVIEW_TASK_NAME });
  });

  it("reads a pull request steward and the agent hired for it, naming it when nobody did", () => {
    expect(parseStandingTaskSpec(STEWARD)).toEqual({ ...STEWARD, name: PR_STEWARD_TASK_NAME });
    expect(parseStandingTaskSpec({ ...STEWARD, agent: "a:b" })).toBeUndefined();
    expect(parseStandingTaskSpec({ ...STEWARD, intervalSeconds: 10 })).toBeUndefined();
    expect(parseStandingTaskSpec({ ...PR_REVIEW, agent: undefined })).toEqual({ ...PR_REVIEW, name: PR_REVIEW_TASK_NAME });
  });

  it("reads a schedule, normalising its expression", () => {
    expect(parseStandingTaskSpec(SCHEDULE)).toEqual({ ...SCHEDULE, cron: "0 9 * * 1-5" });
  });

  it("names a schedule after its instruction when nobody named it", () => {
    expect(parseStandingTaskSpec({ ...SCHEDULE, name: "" })?.name).toBe("Summarise what changed on main since yes");
  });

  it("refuses an interval under a minute, a schedule firing too often, or caps past the limits", () => {
    expect(parseStandingTaskSpec({ ...PR_REVIEW, intervalSeconds: 30 })).toBeUndefined();
    expect(parseStandingTaskSpec({ ...SCHEDULE, cron: "* * * * *" })).toBeUndefined();
    expect(parseStandingTaskSpec({ ...SCHEDULE, cron: "*/2 * * * *" })).toBeUndefined();
    expect(parseStandingTaskSpec({ ...SCHEDULE, instruction: "  " })).toBeUndefined();
    expect(parseStandingTaskSpec({ ...PR_REVIEW, caps: { ...DEFAULT_STANDING_CAPS, perRunUsd: 50 } })).toBeUndefined();
    expect(parseStandingTaskSpec({ ...PR_REVIEW, caps: { ...DEFAULT_STANDING_CAPS, runMinutes: 1.5 } })).toBeUndefined();
    expect(parseStandingTaskSpec({ ...PR_REVIEW, authors: "everyone" })).toBeUndefined();
    expect(parseStandingTaskSpec({ ...PR_REVIEW, id: "../etc" })).toBeUndefined();
    expect(parseStandingTaskSpec({ ...PR_REVIEW, kind: "email" })).toBeUndefined();
  });

  it("sanitises the CEO's words", () => {
    const spec = parseStandingTaskSpec({ ...SCHEDULE, instruction: "Check\u0000 the\n\nboard", name: "a\u001b[31mb" });
    expect(spec?.kind === STANDING_KIND.schedule ? spec.instruction : "").toBe("Check the board");
    expect(spec?.name).toBe("a [31mb");
  });
});

describe("a new schedule", () => {
  it("is a cron no more often than every five minutes, or whole seconds between checks inside the limits", () => {
    expect(parseStandingSchedule({ cron: " 30  9 * * * " })).toEqual({ cron: "30 9 * * *" });
    expect(parseStandingSchedule({ intervalSeconds: 300 })).toEqual({ intervalSeconds: 300 });
    expect(parseStandingSchedule({ cron: "* * * * *" })).toBeUndefined();
    expect(parseStandingSchedule({ intervalSeconds: 30 })).toBeUndefined();
    expect(parseStandingSchedule({ intervalSeconds: 90.5 })).toBeUndefined();
    expect(parseStandingSchedule({ cron: "0 9 * * *", intervalSeconds: 300 })).toBeUndefined();
    expect(parseStandingSchedule("hourly")).toBeUndefined();
  });

  it("goes only on a task of a kind that takes it, as a newer version", () => {
    const schedule = parseStandingTaskSpec(SCHEDULE);
    const steward = parseStandingTaskSpec(STEWARD);
    if (schedule === undefined || steward === undefined) {
      throw new Error("fixtures");
    }
    expect(rescheduled(schedule, { cron: "0 * * * *" })).toMatchObject({ cron: "0 * * * *", version: 3 });
    expect(rescheduled(schedule, { intervalSeconds: 600 })).toBeUndefined();
    expect(rescheduled(steward, { intervalSeconds: 600 })).toMatchObject({ intervalSeconds: 600, version: 2 });
    expect(rescheduled(steward, { cron: "0 * * * *" })).toBeUndefined();
  });

  it("is a command for the task's runner", () => {
    expect(
      toRunnerCommand("c9", { kind: RUNNER_COMMAND_KIND.standingReschedule, taskId: "st-abc123", schedule: { intervalSeconds: 600 }, requestedBy: "Dana" }),
    ).toEqual({ id: "c9", kind: "standing-reschedule", taskId: "st-abc123", schedule: { intervalSeconds: 600 }, requestedBy: "Dana" });
    expect(
      toRunnerCommand("c9", { kind: RUNNER_COMMAND_KIND.standingReschedule, taskId: "st-abc123", schedule: { cron: "* * * * *" }, requestedBy: "Dana" }),
    ).toBeUndefined();
  });
});

describe("a new task from the wall board", () => {
  it("is a kind there is, on any agent or one by key, and a scheduled job's words and cron", () => {
    expect(parseStandingCreateMessage({ kind: "schedule", instruction: " List\u0000 open PRs ", cron: "0  9 * * 1-5", agentId: "agent:runner:box:slot-1" })).toEqual({
      kind: "schedule",
      instruction: "List open PRs",
      cron: "0 9 * * 1-5",
      agentId: "agent:runner:box:slot-1",
    });
    expect(parseStandingCreateMessage({ kind: "pr-steward", instruction: "ignored", cron: "* * * * *", agentId: "" })).toEqual({
      kind: "pr-steward",
      instruction: "",
      cron: "",
      agentId: "",
    });
    expect(parseStandingCreateMessage({ kind: "schedule", instruction: "", cron: "0 9 * * *", agentId: "" })).toBeUndefined();
    expect(parseStandingCreateMessage({ kind: "schedule", instruction: "Spin", cron: "* * * * *", agentId: "" })).toBeUndefined();
    expect(parseStandingCreateMessage({ kind: "email", instruction: "", cron: "", agentId: "" })).toBeUndefined();
    expect(parseStandingCreateMessage({ kind: "pr-review", agentId: 7 })).toBeUndefined();
  });
});

describe("the merge gate", () => {
  const check = (name: string, state: PullCheck["state"], required = false): PullCheck => ({ name, state, required });

  it("merges only when every check passed, a failing one held whether required or not", () => {
    expect(mergeGate([check("ci", "pass", true), check("lint", "pass")], false)).toBeUndefined();
    expect(mergeGate([check("ci", "pass", true), check("lint", "fail")], false)).toEqual({ why: "the check “lint” failed", pending: false });
    expect(mergeGate([check("ci", "fail", true), check("lint", "pass")], false)).toEqual({ why: "the check “ci” failed", pending: false });
    expect(mergeGate([check("ci", "pending", true)], false)).toEqual({ why: "the check “ci” has not finished", pending: true });
    expect(mergeGate([check("ci", "pass", true), check("e2e", "pending")], false)).toEqual({ why: "the check “e2e” has not finished", pending: true });
  });

  it("passes over skipped checks", () => {
    expect(mergeGate([check("ci", "pass"), check("deploy", "skipped")], false)).toBeUndefined();
    expect(mergeGate([check("ci", "skipped", true), check("lint", "pass")], false)).toBeUndefined();
  });

  it("never merges a pull request with no checks, only skipped ones, or more than it read", () => {
    expect(mergeGate([], false)).toEqual({ why: "it has no checks", pending: false });
    expect(mergeGate([check("ci", "skipped", true)], false)).toEqual({ why: "every check was skipped", pending: false });
    expect(mergeGate([check("ci", "pass")], true)?.pending).toBe(false);
  });
});

describe("the steward's next step", () => {
  const green: PullState = {
    open: true,
    draft: false,
    headSha: "abc1234",
    headRef: "feature",
    baseRef: "main",
    crossRepository: false,
    mergeable: "MERGEABLE",
    mergeState: "CLEAN",
    checks: [{ name: "ci", state: "pass", required: true }],
    checksTruncated: false,
  };

  it("merges a clean pull request whose required checks are green", () => {
    expect(stewardStep(green)).toEqual({ kind: "merge" });
    expect(stewardStep({ ...green, mergeState: "HAS_HOOKS" })).toEqual({ kind: "merge" });
  });

  it("never merges with a check failing that is not required, whatever GitHub's merge state says", () => {
    const failing = { ...green, checks: [...green.checks, { name: "e2e", state: "fail", required: false }] } satisfies PullState;
    expect(stewardStep(failing)).toEqual({ kind: "hold", why: "the check “e2e” failed" });
    expect(stewardStep({ ...failing, mergeState: "UNSTABLE" }).kind).toBe("hold");
    // A failing check GitHub reports but the runner did not read still holds it.
    expect(stewardStep({ ...green, mergeState: "UNSTABLE" }).kind).toBe("wait");
  });

  it("resolves conflicts, or a branch behind its base, on the repository's own branches only", () => {
    expect(stewardStep({ ...green, mergeable: "CONFLICTING", mergeState: "DIRTY" })).toEqual({ kind: "resolve" });
    expect(stewardStep({ ...green, mergeState: "BEHIND" })).toEqual({ kind: "resolve" });
    expect(stewardStep({ ...green, mergeable: "CONFLICTING", crossRepository: true }).kind).toBe("hold");
  });

  it("waits on running checks and on GitHub, and holds a failed check or a blocked merge", () => {
    expect(stewardStep({ ...green, checks: [{ name: "ci", state: "pending", required: true }] }).kind).toBe("wait");
    expect(stewardStep({ ...green, mergeable: "UNKNOWN" }).kind).toBe("wait");
    expect(stewardStep({ ...green, draft: true }).kind).toBe("wait");
    expect(stewardStep({ ...green, checks: [{ name: "ci", state: "fail", required: true }] })).toEqual({ kind: "hold", why: "the check “ci” failed" });
    expect(stewardStep({ ...green, checks: [] }).kind).toBe("hold");
    // A required check that has not even started leaves GitHub blocking it, whatever the checks so far say.
    expect(stewardStep({ ...green, mergeState: "BLOCKED" }).kind).toBe("hold");
  });
});

describe("a standing run's record", () => {
  const record = {
    id: "standing-1",
    taskId: "st-abc123",
    startedAt: 1_792_320_000_000,
    endedAt: 1_792_320_060_000,
    outcome: "merged",
    pr: { number: 112, title: "Fix" },
    agent: "Leo",
    costUsd: 0.12,
    summary: "Merged PR #112 “Fix”",
    result: "Every required check passed.\nSquash-merged.",
    log: "● Inspecting PR #112\n✓ merged",
    commentId: 99,
  };

  it("keeps its result's and log's line breaks", () => {
    expect(parseStandingRunRecord(record)).toEqual(record);
  });

  it("refuses one past its budgets, or about something that is not a task", () => {
    expect(parseStandingRunRecord({ ...record, log: "x".repeat(MAX_STANDING_LOG_BYTES + 1) })).toBeUndefined();
    expect(parseStandingRunRecord({ ...record, result: "x".repeat(MAX_STANDING_RESULT_BYTES + 1) })).toBeUndefined();
    expect(parseStandingRunRecord({ ...record, summary: "x".repeat(MAX_STANDING_SUMMARY_BYTES + 1) })).toBeUndefined();
    expect(parseStandingRunRecord({ ...record, taskId: "nope" })).toBeUndefined();
    expect(parseStandingRunRecord({ ...record, outcome: "won" })).toBeUndefined();
  });
});

describe("standing task ids", () => {
  it("are short and plain", () => {
    expect(isStandingTaskId("st-0a1b2c3d")).toBe(true);
    expect(isStandingTaskId("st-")).toBe(false);
    expect(isStandingTaskId("st-ABCD")).toBe(false);
    expect(isStandingTaskId("task-1234")).toBe(false);
  });
});

describe("mayManageStandingTasks", () => {
  it("is the CEO's alone", () => {
    expect(mayManageStandingTasks({ id: "a", kind: OCCUPANT_KIND.human, isCeo: true })).toBe(true);
    expect(mayManageStandingTasks({ id: "b", kind: OCCUPANT_KIND.human, isCeo: false })).toBe(false);
    expect(mayManageStandingTasks({ id: "c", kind: OCCUPANT_KIND.liveAgent, isCeo: false, canTakeIssues: true })).toBe(false);
  });
});

describe("standing commands", () => {
  it("are built without a slot, and only for a definition or an id that is one", () => {
    expect(toRunnerCommand("c1", { kind: RUNNER_COMMAND_KIND.standingSet, spec: PR_REVIEW as never, requestedBy: "Dana" })).toEqual({
      id: "c1",
      kind: "standing-set",
      spec: { ...PR_REVIEW, name: PR_REVIEW_TASK_NAME },
      requestedBy: "Dana",
    });
    expect(toRunnerCommand("c2", { kind: RUNNER_COMMAND_KIND.standingPause, taskId: "st-abc123", requestedBy: "Dana" })).toEqual({
      id: "c2",
      kind: "standing-pause",
      taskId: "st-abc123",
      requestedBy: "Dana",
    });
    expect(toRunnerCommand("c3", { kind: RUNNER_COMMAND_KIND.standingRemove, taskId: "nope", requestedBy: "Dana" })).toBeUndefined();
    expect(
      toRunnerCommand("c4", { kind: RUNNER_COMMAND_KIND.standingSet, spec: { ...SCHEDULE, cron: "* * * * *" } as never, requestedBy: "D" }),
    ).toBeUndefined();
  });
});

describe("standing state on a sync", () => {
  const report = {
    id: "st-abc123",
    kind: "pr-review",
    name: "Watch for new pull requests",
    status: "waiting-slot",
    trigger: "every 2 min",
    schedule: { intervalSeconds: 120 },
    lastCheckAt: 1_792_320_000_000,
    nextCheckAt: 1_792_320_120_000,
    queued: 2,
    handledToday: 1,
    spentTodayUsd: 0.2,
    dailyUsd: 2,
    lastError: "",
    recent: [{ at: 1_792_320_000_000, outcome: "simulated", pr: 112 }],
  };

  it("reads each task's report, the slot on a standing run, and a standing run's event", () => {
    const parsed = parseRunnerSync({
      runnerId: "r",
      repo: "o/r",
      slots: [{ id: "slot-1", status: "working", standing: { taskId: "st-abc123", pr: 112 } }],
      events: [
        { id: "e1", kind: "standing-run", taskId: "st-abc123", slotId: "slot-1", pr: { number: 112, title: "Fix" }, outcome: "reviewed", commentId: 99, costUsd: 0.12, message: "", final: false },
        { id: "e2", kind: "standing-refused", taskId: "st-abc123", name: "Watch", message: "no budget" },
      ],
      standing: [report],
      standingOff: "no-budget",
    });
    expect(parsed?.standing).toEqual([{ ...report, agent: undefined }]);
    expect(parsed?.standingOff).toBe("no-budget");
    expect(parsed?.slots[0]?.standing).toEqual({ taskId: "st-abc123", pr: 112 });
    expect(parsed?.events[0]).toEqual({
      id: "e1",
      kind: "standing-run",
      taskId: "st-abc123",
      slotId: "slot-1",
      pr: { number: 112, title: "Fix" },
      outcome: "reviewed",
      commentId: 99,
      costUsd: 0.12,
      message: "",
      final: false,
    });
    expect(parsed?.events[1]?.kind).toBe("standing-refused");
  });

  it("reads a task with no standing budget as uncapped, and refuses a cap that is not dollars", () => {
    const { dailyUsd: _none, ...uncapped } = report;
    const sync = { runnerId: "r", repo: "o/r", slots: [], standing: [uncapped] };
    expect(parseRunnerSync(sync)?.standing).toEqual([{ ...uncapped, agent: undefined, dailyUsd: undefined }]);
    expect(parseRunnerSync({ ...sync, standing: [{ ...report, dailyUsd: -1 }] })).toBeUndefined();
  });

  it("refuses a sync with too many tasks, a task twice, or a task it cannot read", () => {
    const sync = { runnerId: "r", repo: "o/r" };
    const many = Array.from({ length: MAX_STANDING_TASKS + 1 }, (_, index) => ({ ...report, id: `st-task${index}` }));
    expect(parseRunnerSync({ ...sync, standing: many })).toBeUndefined();
    expect(parseRunnerSync({ ...sync, standing: [report, report] })).toBeUndefined();
    expect(parseRunnerSync({ ...sync, standing: [{ ...report, status: "sleeping" }] })).toBeUndefined();
    expect(parseRunnerSync({ ...sync, standing: [{ ...report, lastError: "x".repeat(MAX_STANDING_ERROR_BYTES + 1) }] })).toBeUndefined();
    expect(parseRunnerSync({ ...sync, standingOff: "tired" })).toBeUndefined();
  });

  /**
   * Every list at its cap and every string at its budget, in characters
   * whose JSON escapes are as long as any: a sync the parser takes, and the
   * largest one it would.
   */
  it("keeps a maximal sync, four standing tasks with it, under the route's limit", () => {
    // Two bytes a character, so a string of them is its whole budget in half the characters.
    const bytes = (budget: number): string => "é".repeat(Math.floor(budget / 2));
    const id64 = "i".repeat(64);
    const slot32 = "s".repeat(32);
    const url = `https://github.com/${"a".repeat(39)}/${"b".repeat(100)}/pull/${"9".repeat(300 - 165)}`;
    const usd = 999_999.123_456_789;
    const pr = { number: 0xffffffff, title: bytes(90), url };
    const workEvent = { id: id64, kind: "pr-opened", slotId: slot32, issueNumber: 0xffffffff, pr, message: bytes(280), refusal: "budget" };
    const standingEvent = {
      id: id64,
      kind: "standing-run",
      taskId: "st-" + "a".repeat(16),
      slotId: slot32,
      pr: { number: 0xffffffff, title: bytes(90) },
      outcome: "refused-budget",
      commentId: Number.MAX_SAFE_INTEGER,
      costUsd: usd,
      message: bytes(MAX_STANDING_MESSAGE_BYTES),
      final: false,
    } satisfies Omit<RunnerStandingRunEvent, "kind"> & { kind: string };
    const tasks = Array.from({ length: MAX_STANDING_TASKS }, (_, index) => ({
      id: `st-${String(index).repeat(16)}`,
      kind: "pr-review",
      name: bytes(MAX_STANDING_NAME_BYTES),
      status: "waiting-slot",
      trigger: bytes(MAX_STANDING_TRIGGER_BYTES),
      // The longest cron a schedule takes, at its byte budget.
      schedule: { cron: "0,5,10,15,20,25,30,35,40,45,50,55 0-23 1-31 1-12 0-6" },
      agent: slot32,
      lastCheckAt: 9_999_999_999_999,
      nextCheckAt: 9_999_999_999_999,
      queued: 0xffffffff,
      handledToday: 0xffffffff,
      spentTodayUsd: usd,
      dailyUsd: usd,
      lastError: bytes(MAX_STANDING_ERROR_BYTES),
      recent: Array.from({ length: MAX_STANDING_RECENT }, () => ({ at: 9_999_999_999_999, outcome: "refused-budget", pr: 0xffffffff })),
    }));
    for (const event of [workEvent, standingEvent]) {
      const sync = {
        runnerId: "r".repeat(32),
        repo: `${"a".repeat(39)}/${"b".repeat(100)}`,
        acked: Array.from({ length: MAX_RUNNER_ACKS }, () => id64),
        slots: Array.from({ length: MAX_RUNNER_SLOTS }, (_, index) => ({
          id: `${"s".repeat(31)}${index}`,
          name: bytes(18),
          title: bytes(MAX_AGENT_TITLE_BYTES),
          description: bytes(MAX_AGENT_DESCRIPTION_BYTES),
          status: "needs-input",
          activity: bytes(90),
          // A slot holds an issue or a standing run, never both; the issue's is the larger.
          ...(index % 2 === 0 ? { issueNumber: 0xffffffff, pr } : { standing: { taskId: `st-${"z".repeat(16)}`, pr: 0xffffffff } }),
        })),
        events: Array.from({ length: MAX_RUNNER_EVENTS }, () => event),
        spend: { spentUsd: usd, budgetUsd: usd },
        prompts: Array.from({ length: MAX_RUNNER_PROMPT_OUTCOMES }, () => ({ commandId: id64, slotId: slot32, outcome: "answered", text: bytes(MAX_RUNNER_ANSWER_BYTES) })),
        standing: tasks,
        standingOff: "no-budget",
        changesIssues: true,
        issueStates: Array.from({ length: MAX_RUNNER_ISSUE_STATE_OUTCOMES }, () => ({ commandId: id64, outcome: "refused" })),
        standingRuns: [
          {
            id: id64,
            taskId: "st-" + "r".repeat(16),
            startedAt: 9_999_999_999_999,
            endedAt: 9_999_999_999_999,
            outcome: "refused-budget",
            pr: { number: 0xffffffff, title: bytes(90) },
            agent: bytes(MAX_STANDING_NAME_BYTES),
            costUsd: usd,
            summary: bytes(MAX_STANDING_SUMMARY_BYTES),
            result: bytes(MAX_STANDING_RESULT_BYTES),
            log: bytes(MAX_STANDING_LOG_BYTES),
            commentId: Number.MAX_SAFE_INTEGER,
          },
        ],
      };
      const parsed = parseRunnerSync(sync);
      expect(parsed).toBeDefined();
      expect(parsed?.standing).toHaveLength(MAX_STANDING_TASKS);
      expect(parsed?.standingRuns).toHaveLength(1);
      expect(parsed?.slots[0]?.description).toBe(bytes(MAX_AGENT_DESCRIPTION_BYTES));
      expect(Buffer.byteLength(JSON.stringify(sync))).toBeLessThan(MAX_RUNNER_SYNC_BYTES);
    }
  });
});
