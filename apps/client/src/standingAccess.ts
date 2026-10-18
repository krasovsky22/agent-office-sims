/**
 * The roster's standing tasks: how each reads on its row, and what the local
 * player may do about one, in words the HUD can show.
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

/** Copies a replicated task into plain data, so React never holds a schema object. */
export function copyStandingTask(task: StandingTaskData): StandingTaskData {
  return {
    id: task.id,
    runnerId: task.runnerId,
    kind: task.kind,
    name: task.name,
    status: task.status,
    trigger: task.trigger,
    lastCheckAt: task.lastCheckAt,
    nextCheckAt: task.nextCheckAt,
    queued: task.queued,
    handledToday: task.handledToday,
    spentTodayUsd: task.spentTodayUsd,
    dailyUsd: task.dailyUsd,
    lastError: task.lastError,
    lastOutcome: task.lastOutcome,
    lastRunAt: task.lastRunAt,
    lastRunPr: task.lastRunPr,
    runningAgentId: task.runningAgentId,
  };
}

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
  return { mayManage: false, reason: `Only ${who} can pause, resume, remove or check a standing task.` };
}

const REJECTION_TEXT: Readonly<Record<StandingRejection, string>> = {
  [STANDING_REJECTION.forbidden]: "Only the CEO can pause, resume, remove or check a standing task.",
  [STANDING_REJECTION.unknownTask]: "That standing task is gone.",
  [STANDING_REJECTION.noRunner]: "No agent runner is connected.",
  [STANDING_REJECTION.runnerRefuses]: "The runner takes no standing tasks.",
  [STANDING_REJECTION.full]: "Every runner already holds as many standing tasks as it can.",
  [STANDING_REJECTION.duplicate]: "The office already watches for new pull requests.",
  [STANDING_REJECTION.unreachable]: "The runner could not be given that; it may be offline. Try again shortly.",
  [STANDING_REJECTION.invalid]: "That isn't a standing task a runner can take.",
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
