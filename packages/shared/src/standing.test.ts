/**
 * Standing tasks' contract: a definition is proved before a runner keeps it,
 * the CEO alone may manage one, and a sync carrying every task a runner may
 * hold still fits inside the route's body limit.
 */

import { describe, expect, it } from "vitest";

import { OCCUPANT_KIND } from "./state.js";
import {
  MAX_RUNNER_ACKS,
  MAX_RUNNER_EVENTS,
  MAX_RUNNER_PROMPT_OUTCOMES,
  MAX_RUNNER_SLOTS,
  MAX_RUNNER_ISSUE_STATE_OUTCOMES,
  MAX_RUNNER_SYNC_BYTES,
  RUNNER_COMMAND_KIND,
  type RunnerStandingRunEvent,
  parseRunnerSync,
  toRunnerCommand,
} from "./runner.js";
import {
  DEFAULT_STANDING_CAPS,
  MAX_STANDING_MESSAGE_BYTES,
  MAX_STANDING_NAME_BYTES,
  MAX_STANDING_RECENT,
  MAX_STANDING_TASKS,
  MAX_STANDING_TRIGGER_BYTES,
  MAX_STANDING_ERROR_BYTES,
  PR_REVIEW_TASK_NAME,
  STANDING_KIND,
  isStandingTaskId,
  mayManageStandingTasks,
  parseStandingTaskSpec,
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
    expect(parsed?.standing).toEqual([report]);
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
          status: "needs-input",
          activity: bytes(90),
          // A slot holds an issue or a standing run, never both; the issue's is the larger.
          ...(index % 2 === 0 ? { issueNumber: 0xffffffff, pr } : { standing: { taskId: `st-${"z".repeat(16)}`, pr: 0xffffffff } }),
        })),
        events: Array.from({ length: MAX_RUNNER_EVENTS }, () => event),
        spend: { spentUsd: usd, budgetUsd: usd },
        prompts: Array.from({ length: MAX_RUNNER_PROMPT_OUTCOMES }, () => ({ commandId: id64, slotId: slot32, outcome: "needs-input" })),
        standing: tasks,
        standingOff: "no-budget",
        changesIssues: true,
        issueStates: Array.from({ length: MAX_RUNNER_ISSUE_STATE_OUTCOMES }, () => ({ commandId: id64, outcome: "refused" })),
      };
      const parsed = parseRunnerSync(sync);
      expect(parsed).toBeDefined();
      expect(parsed?.standing).toHaveLength(MAX_STANDING_TASKS);
      expect(Buffer.byteLength(JSON.stringify(sync))).toBeLessThan(MAX_RUNNER_SYNC_BYTES);
    }
  });
});
