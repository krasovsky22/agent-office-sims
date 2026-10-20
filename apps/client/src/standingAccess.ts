/**
 * The roster's standing tasks and the recurring tasks' wall board: how each
 * task reads on its row and on the board, the schedules the board offers the
 * CEO, and what the local player may do about one, in words the HUD can show.
 *
 * The decision is not made here: `mayManageStandingTasks` in `@sim/shared`
 * is the rule the server enforces, and this module only asks it about the
 * local player, so the buttons are disabled exactly when the server would
 * refuse them, and say why. Like `managerAccess.ts` for the AI Manager.
 */

import {
  type OfficeActor,
  STANDING_KIND,
  STANDING_OUTCOME_TEXT,
  STANDING_REJECTION,
  STANDING_STATUS,
  STANDING_STATUS_TEXT,
  type StandingRejection,
  type StandingTask,
  formatUsd,
  isStandingOutcome,
  isStandingStatus,
  mayManageStandingTasks,
} from "@sim/shared";

/** One standing task as the state replicates it, copied into plain data for the HUD. */
export type StandingTaskData = Readonly<
  Pick<
    StandingTask,
    | "id"
    | "runnerId"
    | "kind"
    | "name"
    | "status"
    | "trigger"
    | "cron"
    | "intervalSeconds"
    | "agentId"
    | "lastCheckAt"
    | "nextCheckAt"
    | "queued"
    | "handledToday"
    | "spentTodayUsd"
    | "dailyUsd"
    | "lastError"
    | "lastOutcome"
    | "lastRunAt"
    | "lastRunPr"
    | "runningAgentId"
  >
>;

/** The local player's standing with the standing tasks. */
export interface StandingAccess {
  /** Whether the buttons do anything the server will take. */
  readonly mayManage: boolean;
  /** Why they are disabled, for their tooltip; `""` for the CEO. */
  readonly reason: string;
}

export function standingAccessFor(actor: OfficeActor, ceoName: string | undefined): StandingAccess {
  if (mayManageStandingTasks(actor)) {
    return { mayManage: true, reason: "" };
  }
  const who = ceoName === undefined ? "the CEO" : `the CEO, ${ceoName},`;
  return { mayManage: false, reason: `Only ${who} can pause, resume, remove, check or reschedule a standing task.` };
}

const REJECTION_TEXT: Readonly<Record<StandingRejection, string>> = {
  [STANDING_REJECTION.forbidden]: "Only the CEO can pause, resume, remove, check or reschedule a standing task.",
  [STANDING_REJECTION.unknownTask]: "That standing task is gone.",
  [STANDING_REJECTION.noRunner]: "No agent runner is connected.",
  [STANDING_REJECTION.runnerRefuses]: "The runner takes no standing tasks.",
  [STANDING_REJECTION.full]: "Every runner already holds as many standing tasks as it can.",
  [STANDING_REJECTION.duplicate]: "The office already watches for new pull requests.",
  [STANDING_REJECTION.unreachable]: "The runner could not be given that; it may be offline. Try again shortly.",
  [STANDING_REJECTION.invalid]: "That isn't a schedule or a standing task a runner can take.",
};

/** What to tell the player when the office did nothing about their button. */
export function standingRejectionText(rejection: StandingRejection): string {
  return REJECTION_TEXT[rejection];
}

/** `just now`, `4 min ago`, `2 h ago`. */
export function agoText(at: number, now: number): string {
  const minutes = Math.floor(Math.max(now - at, 0) / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  return minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ago`;
}

/** A task's row: its name and status, then what it does and how it has gone. */
export interface StandingRow {
  /** `Watch for new pull requests · active`. */
  readonly title: string;
  readonly lines: readonly string[];
  readonly paused: boolean;
  /** Something is wrong with it: over its budget, or its last check or run failed. */
  readonly alert: boolean;
}

export function standingRow(task: StandingTaskData, now: number): StandingRow {
  const status = isStandingStatus(task.status) ? STANDING_STATUS_TEXT[task.status] : task.status;
  const checked = task.lastCheckAt === 0 ? "not checked yet" : `checked ${agoText(task.lastCheckAt, now)}`;
  const lines = [`${task.trigger} · ${task.kind === STANDING_KIND.schedule ? checked.replace("checked", "fired") : checked}`];
  if (task.lastOutcome !== "") {
    const outcome = isStandingOutcome(task.lastOutcome) ? STANDING_OUTCOME_TEXT[task.lastOutcome] : task.lastOutcome;
    lines.push(`Last: ${outcome}${task.lastRunPr === 0 ? "" : ` PR #${task.lastRunPr}`}`);
  }
  const waiting = task.queued === 0 ? "" : ` · ${task.queued} waiting for a slot`;
  lines.push(`${formatUsd(task.spentTodayUsd)} of ${formatUsd(task.dailyUsd)} today${waiting}`);
  if (task.lastError !== "") {
    lines.push(task.lastError);
  }
  return {
    title: `${task.name} · ${status}`,
    lines,
    paused: task.status === STANDING_STATUS.paused,
    alert: task.status === STANDING_STATUS.overBudget || task.status === STANDING_STATUS.error,
  };
}

/** How a task's status reads at a glance on the wall board. */
export type RecurringTone = "good" | "pending" | "bad" | "plain";

const STATUS_TONE: Readonly<Record<string, RecurringTone>> = {
  [STANDING_STATUS.active]: "good",
  [STANDING_STATUS.running]: "pending",
  [STANDING_STATUS.waitingSlot]: "pending",
  [STANDING_STATUS.overBudget]: "bad",
  [STANDING_STATUS.error]: "bad",
  [STANDING_STATUS.paused]: "plain",
};

/** What a kind of task does, in a few words. */
export const STANDING_KIND_TEXT: Readonly<Record<string, string>> = {
  [STANDING_KIND.prReview]: "Reviews new pull requests",
  [STANDING_KIND.prSteward]: "Reviews, resolves and merges new pull requests",
  [STANDING_KIND.schedule]: "Scheduled job",
};

/** One task on the recurring tasks' board: what it is, how often, how its last run went, and how it stands. */
export interface RecurringRow {
  readonly name: string;
  /** `Scheduled job · weekdays 09:00`, with the agent hired for it. */
  readonly schedule: string;
  /** `Last run 4 min ago: merged PR #112`, or `Not run yet`. */
  readonly lastRun: string;
  readonly status: string;
  readonly tone: RecurringTone;
}

/** @param agentName the name of the agent hired for it, when one was. */
export function recurringRow(task: StandingTaskData, now: number, agentName: string | undefined): RecurringRow {
  const kind = STANDING_KIND_TEXT[task.kind] ?? task.kind;
  const outcome = isStandingOutcome(task.lastOutcome) ? STANDING_OUTCOME_TEXT[task.lastOutcome] : task.lastOutcome;
  return {
    name: task.name,
    schedule: `${kind} · ${task.trigger}${agentName === undefined ? "" : ` · ${agentName}'s`}`,
    lastRun:
      task.lastRunAt === 0 ? "Not run yet" : `Last run ${agoText(task.lastRunAt, now)}: ${outcome}${task.lastRunPr === 0 ? "" : ` PR #${task.lastRunPr}`}`,
    status: isStandingStatus(task.status) ? STANDING_STATUS_TEXT[task.status] : task.status,
    tone: STATUS_TONE[task.status] ?? "plain",
  };
}

/** The schedules the wall board offers a scheduled job; `custom` takes any five-field cron. */
export type ScheduleChoice =
  | { readonly kind: "hourly" }
  | { readonly kind: "daily" | "weekdays"; readonly time: string }
  | { readonly kind: "custom"; readonly cron: string };

/** The minutes between checks the wall board offers a pull request task. */
export const CHECK_MINUTES: readonly number[] = [1, 2, 5, 10, 15, 30, 60];

/** A cron as the board's choices read it, so its control starts where the task is. */
export function scheduleChoice(cron: string): ScheduleChoice {
  if (cron === "0 * * * *") {
    return { kind: "hourly" };
  }
  const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5)$/.exec(cron);
  if (match !== null) {
    const time = `${(match[2] ?? "").padStart(2, "0")}:${(match[1] ?? "").padStart(2, "0")}`;
    return { kind: match[3] === "*" ? "daily" : "weekdays", time };
  }
  return { kind: "custom", cron };
}

/** The cron a choice stands for; `undefined` for a time that is not `HH:MM`. */
export function cronOfChoice(choice: ScheduleChoice): string | undefined {
  if (choice.kind === "hourly") {
    return "0 * * * *";
  }
  if (choice.kind === "custom") {
    return choice.cron.trim().replace(/\s+/g, " ");
  }
  const match = /^(\d{1,2}):(\d{2})$/.exec(choice.time);
  const hour = Number(match?.[1]);
  const minute = Number(match?.[2]);
  if (match === null || hour > 23 || minute > 59) {
    return undefined;
  }
  return `${minute} ${hour} * * ${choice.kind === "daily" ? "*" : "1-5"}`;
}
