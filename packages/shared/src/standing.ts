/**
 * Standing tasks: work an office agent does again and again, rather than once
 * to a pull request, and the one rule about who may set one up.
 *
 * Two kinds:
 *
 * - **`pr-review`**, "watch for new pull requests": the runner polls GitHub's
 *   open pull requests, and each new one, from a collaborator or the runner's
 *   own agents and not a draft, is reviewed once by a fresh, short, read-only
 *   agent run, whose review the runner posts as a comment. Never an approval
 *   or a request for changes.
 * - **`schedule`**, a recurring job: on a cron schedule (`./cron.ts`) the
 *   runner starts a fresh, short agent run with the CEO's instruction, and the
 *   AI Manager says what came of it.
 *
 * The runner owns a task once it has it: its definition, its trigger, its
 * record of what it handled and its spend, on its own disk. The server owns
 * who may create, pause, resume, remove and check one, which is
 * {@link mayManageStandingTasks}, the CEO, from the roster's buttons and
 * through the AI Manager alike. Every run is capped in money and minutes by
 * {@link StandingCaps}, and the runner caps them again itself whatever a
 * definition says.
 *
 * Shared because a definition crosses the runner link as a command, a task's
 * state crosses back on every sync, and the client asks the same rule as the
 * server to grey out a button.
 */

import { MAX_MANAGER_MESSAGE_LENGTH } from "./constants.js";
import { parseCron, scheduleRefusal } from "./cron.js";
import { sanitizeManagerText, sanitizeTitle } from "./messages.js";
import type { OfficeActor } from "./work.js";

/** What a standing task does. */
export const STANDING_KIND = {
  /** Reviews each new pull request once. */
  prReview: "pr-review",
  /** Runs the CEO's instruction on a cron schedule. */
  schedule: "schedule",
} as const;

export type StandingKind = (typeof STANDING_KIND)[keyof typeof STANDING_KIND];

/** Whose pull requests a `pr-review` task reviews. */
export const STANDING_AUTHORS = {
  /** The repository's owner, members and collaborators, and the runner's own agents. */
  collaborators: "collaborators",
  anyone: "anyone",
} as const;

export type StandingAuthors = (typeof STANDING_AUTHORS)[keyof typeof STANDING_AUTHORS];

/** Where a standing task stands, as its runner reports it. */
export const STANDING_STATUS = {
  /** Waiting for its next check or firing. */
  active: "active",
  paused: "paused",
  /** It has something to do and no slot is free for it. */
  waitingSlot: "waiting-slot",
  running: "running",
  /** Its own daily spend or hourly runs, or the runner's standing budget, are used up. */
  overBudget: "over-budget",
  /** Its last check or run went wrong. */
  error: "error",
} as const;

export type StandingStatus = (typeof STANDING_STATUS)[keyof typeof STANDING_STATUS];

/** What came of one run, or one event a task looked at. */
export const STANDING_OUTCOME = {
  /** A real review was posted on the pull request. */
  reviewed: "reviewed",
  /** A scheduled run finished, with its result. */
  completed: "completed",
  /** The mock agent's pretend run: nothing was posted or done. */
  simulated: "simulated",
  failed: "failed",
  /** Left alone: an outside contributor's pull request, or a firing missed while it could not run. */
  skipped: "skipped",
  /** Issue work took its slot; it runs again later. */
  preempted: "preempted",
  /** Not started: a budget is spent. */
  refusedBudget: "refused-budget",
} as const;

export type StandingOutcome = (typeof STANDING_OUTCOME)[keyof typeof STANDING_OUTCOME];

/**
 * Why a runner takes no standing tasks at all, as it says on every sync, so
 * the office can say so before it asks.
 */
export const STANDING_OFF = {
  /** A real agent's runner whose operator has not set `RUNNER_STANDING_DAILY_BUDGET_USD`. */
  noBudget: "no-budget",
} as const;

export type StandingOff = (typeof STANDING_OFF)[keyof typeof STANDING_OFF];

/** Most standing tasks one runner holds, which keeps a sync inside its byte budget. */
export const MAX_STANDING_TASKS = 4;

/** Longest task name, in code points: a roster row's width. */
export const MAX_STANDING_NAME_LENGTH = 40;

/** Longest scheduled instruction: what the CEO may say to the AI Manager in one message. */
export const MAX_STANDING_INSTRUCTION_LENGTH = MAX_MANAGER_MESSAGE_LENGTH;

/** Runs a report lists, newest first. */
export const MAX_STANDING_RECENT = 3;

/** How often a `pr-review` task checks by default, and at most. */
export const DEFAULT_STANDING_INTERVAL_SECONDS = 120;
export const MIN_STANDING_INTERVAL_SECONDS = 60;
export const MAX_STANDING_INTERVAL_SECONDS = 24 * 60 * 60;

/** What one task may spend and take, per run and per day. */
export interface StandingCaps {
  /** US dollars one run may spend before it is stopped. */
  readonly perRunUsd: number;
  /** Minutes one run may take before it is stopped. */
  readonly runMinutes: number;
  /** US dollars the task may spend in a day before it starts nothing more that day. */
  readonly dailyUsd: number;
  /** Runs the task may start in any hour. */
  readonly maxRunsPerHour: number;
}

export const DEFAULT_STANDING_CAPS: StandingCaps = { perRunUsd: 0.5, runMinutes: 10, dailyUsd: 2, maxRunsPerHour: 6 };

/** The most a definition may ask for; the runner may hold a task to less. */
export const MAX_STANDING_CAPS: StandingCaps = { perRunUsd: 5, runMinutes: 30, dailyUsd: 50, maxRunsPerHour: 12 };

interface StandingSpecBase {
  /** The server's id for it, {@link isStandingTaskId}: in the posted comment's marker, so never reused. */
  readonly id: string;
  readonly name: string;
  readonly paused: boolean;
  /** The CEO's words, given to every run as context; `""` for none. */
  readonly note: string;
  /** Bumped by an edit, so the runner keeps the newest definition. */
  readonly version: number;
  readonly caps: StandingCaps;
}

export interface PrReviewSpec extends StandingSpecBase {
  readonly kind: typeof STANDING_KIND.prReview;
  /** Seconds between checks, from {@link MIN_STANDING_INTERVAL_SECONDS}. Drafts are always skipped. */
  readonly intervalSeconds: number;
  readonly authors: StandingAuthors;
}

export interface ScheduleSpec extends StandingSpecBase {
  readonly kind: typeof STANDING_KIND.schedule;
  /** Five-field cron, on the runner's clock; see `./cron.ts`. */
  readonly cron: string;
  /** What each run is to do, in the CEO's words. */
  readonly instruction: string;
}

export type StandingTaskSpec = PrReviewSpec | ScheduleSpec;

/** A task's id: short, since it rides in every report and every comment's marker. */
const STANDING_ID = /^st-[a-z0-9]{4,16}$/;

/** Whether a value is a standing task's id. */
export function isStandingTaskId(value: unknown): value is string {
  return typeof value === "string" && STANDING_ID.test(value);
}

/** What a standing task is called when nobody named it. */
export const PR_REVIEW_TASK_NAME = "Watch for new pull requests";

/** A task name, one line of at most {@link MAX_STANDING_NAME_LENGTH} code points. */
export function sanitizeStandingName(raw: unknown): string {
  return Array.from(sanitizeTitle(raw)).slice(0, MAX_STANDING_NAME_LENGTH).join("").trim();
}

function asRecord(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
}

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function isWhole(value: unknown, min: number, max: number): value is number {
  return inRange(value, min, max) && Number.isInteger(value);
}

/** `undefined` for caps that are not, or ask for more than {@link MAX_STANDING_CAPS}. */
export function parseStandingCaps(raw: unknown): StandingCaps | undefined {
  const caps = asRecord(raw);
  if (caps === undefined) {
    return undefined;
  }
  const { perRunUsd, runMinutes, dailyUsd, maxRunsPerHour } = caps;
  if (
    !inRange(perRunUsd, 0.01, MAX_STANDING_CAPS.perRunUsd) ||
    !isWhole(runMinutes, 1, MAX_STANDING_CAPS.runMinutes) ||
    !inRange(dailyUsd, 0.01, MAX_STANDING_CAPS.dailyUsd) ||
    !isWhole(maxRunsPerHour, 1, MAX_STANDING_CAPS.maxRunsPerHour)
  ) {
    return undefined;
  }
  return { perRunUsd, runMinutes, dailyUsd, maxRunsPerHour };
}

/**
 * Validates a task's definition, as the runner does a `standing-set`
 * command's and as its own store is read back: every field proved, every
 * string sanitised, a name given where none was, and nothing past its limit.
 *
 * @returns the definition, or `undefined` for one that is not.
 */
export function parseStandingTaskSpec(raw: unknown): StandingTaskSpec | undefined {
  const spec = asRecord(raw);
  if (spec === undefined || !isStandingTaskId(spec["id"]) || !isWhole(spec["version"], 1, 0xffffffff)) {
    return undefined;
  }
  const caps = parseStandingCaps(spec["caps"]);
  if (caps === undefined || typeof spec["paused"] !== "boolean") {
    return undefined;
  }
  const note = sanitizeManagerText(spec["note"]);
  const base = { id: spec["id"], paused: spec["paused"], note, version: spec["version"], caps };
  switch (spec["kind"]) {
    case STANDING_KIND.prReview: {
      const { intervalSeconds, authors } = spec;
      if (!isWhole(intervalSeconds, MIN_STANDING_INTERVAL_SECONDS, MAX_STANDING_INTERVAL_SECONDS)) {
        return undefined;
      }
      if (authors !== STANDING_AUTHORS.collaborators && authors !== STANDING_AUTHORS.anyone) {
        return undefined;
      }
      const name = sanitizeStandingName(spec["name"]) || PR_REVIEW_TASK_NAME;
      return { ...base, kind: STANDING_KIND.prReview, name, intervalSeconds, authors };
    }
    case STANDING_KIND.schedule: {
      const cron = typeof spec["cron"] === "string" ? spec["cron"].trim().replace(/\s+/g, " ") : "";
      const instruction = sanitizeManagerText(spec["instruction"]);
      if (scheduleRefusal(cron) !== undefined || instruction === "") {
        return undefined;
      }
      const name = sanitizeStandingName(spec["name"]) || sanitizeStandingName(instruction);
      return { ...base, kind: STANDING_KIND.schedule, name, cron: parseCron(cron)?.expression ?? cron, instruction };
    }
    default:
      return undefined;
  }
}

/**
 * Whether an actor may create, pause, resume, remove or check a standing
 * task. **The one gate.** A standing task spends money unattended, so it is
 * the CEO's, as handing out work is. The server checks it on every message
 * and every plan of the AI Manager's; the client asks it only to disable a
 * button and say why.
 */
export function mayManageStandingTasks(actor: OfficeActor): boolean {
  return actor.isCeo;
}

/** What the CEO can do to a standing task from the roster or through the AI Manager. */
export const STANDING_ACTION = {
  create: "create",
  pause: "pause",
  resume: "resume",
  remove: "remove",
  checkNow: "check-now",
} as const;

export type StandingAction = (typeof STANDING_ACTION)[keyof typeof STANDING_ACTION];

/** The actions on a task that exists, which the roster's buttons send. */
export type StandingTaskAction = Exclude<StandingAction, typeof STANDING_ACTION.create>;

/** Why the office did nothing about a standing task. */
export const STANDING_REJECTION = {
  /** Only the CEO manages standing tasks. */
  forbidden: "forbidden",
  /** No task in the office has that id. */
  unknownTask: "unknown-task",
  /** No runner is connected to take one. */
  noRunner: "no-runner",
  /** Every runner connected takes no standing tasks, and says why. */
  runnerRefuses: "runner-refuses",
  /** Every runner that takes them holds {@link MAX_STANDING_TASKS} already. */
  full: "full",
  /** The office already watches for new pull requests. */
  duplicate: "duplicate",
  /** Its runner could not be given the command; it may be offline. */
  unreachable: "unreachable",
  /** The definition asks for something no runner takes, such as a schedule firing every minute. */
  invalid: "invalid",
} as const;

export type StandingRejection = (typeof STANDING_REJECTION)[keyof typeof STANDING_REJECTION];

/** One run, as a task's report lists its last few. */
export interface StandingRunSummary {
  /** Epoch ms it ended, or was looked at. */
  readonly at: number;
  readonly outcome: StandingOutcome;
  /** The pull request it was about, for a `pr-review` task. */
  readonly pr?: number | undefined;
}

/** One standing task, as its runner reports it on every sync. */
export interface StandingTaskReport {
  readonly id: string;
  readonly kind: StandingKind;
  readonly name: string;
  readonly status: StandingStatus;
  /** Its trigger in a few words: `every 2 min`, `weekdays 09:00`. */
  readonly trigger: string;
  /** Epoch ms of its last check of GitHub or firing; `undefined` before the first. */
  readonly lastCheckAt: number | undefined;
  /** Epoch ms of its next; `undefined` while paused or over budget. */
  readonly nextCheckAt: number | undefined;
  /** Events waiting for a slot. */
  readonly queued: number;
  /** Runs that ended today. */
  readonly handledToday: number;
  readonly spentTodayUsd: number;
  readonly dailyUsd: number;
  /** Its last error, short; `""` when there is none. */
  readonly lastError: string;
  /** Newest first, at most {@link MAX_STANDING_RECENT}. */
  readonly recent: readonly StandingRunSummary[];
}

/** Longest task name a report or event carries, in bytes. */
export const MAX_STANDING_NAME_BYTES = 64;

/** Longest trigger description, in bytes. */
export const MAX_STANDING_TRIGGER_BYTES = 24;

/** Longest last error, in bytes. */
export const MAX_STANDING_ERROR_BYTES = 64;

/** Longest result or reason one standing event carries, in bytes. */
export const MAX_STANDING_MESSAGE_BYTES = 500;

const STATUSES: ReadonlySet<string> = new Set(Object.values(STANDING_STATUS));
const OUTCOMES: ReadonlySet<string> = new Set(Object.values(STANDING_OUTCOME));
const KINDS: ReadonlySet<string> = new Set(Object.values(STANDING_KIND));

export function isStandingStatus(value: unknown): value is StandingStatus {
  return typeof value === "string" && STATUSES.has(value);
}

export function isStandingOutcome(value: unknown): value is StandingOutcome {
  return typeof value === "string" && OUTCOMES.has(value);
}

export function isStandingKind(value: unknown): value is StandingKind {
  return typeof value === "string" && KINDS.has(value);
}

/** How a standing outcome reads on a roster row and in the AI Manager's words. */
export const STANDING_OUTCOME_TEXT: Readonly<Record<StandingOutcome, string>> = {
  [STANDING_OUTCOME.reviewed]: "reviewed",
  [STANDING_OUTCOME.completed]: "done",
  [STANDING_OUTCOME.simulated]: "simulated",
  [STANDING_OUTCOME.failed]: "failed",
  [STANDING_OUTCOME.skipped]: "skipped",
  [STANDING_OUTCOME.preempted]: "preempted by issue work",
  [STANDING_OUTCOME.refusedBudget]: "refused: budget spent",
};

/** How a status reads on a roster row: `Watch for new pull requests · active`. */
export const STANDING_STATUS_TEXT: Readonly<Record<StandingStatus, string>> = {
  [STANDING_STATUS.active]: "active",
  [STANDING_STATUS.paused]: "paused",
  [STANDING_STATUS.waitingSlot]: "waiting for a slot",
  [STANDING_STATUS.running]: "running",
  [STANDING_STATUS.overBudget]: "over budget",
  [STANDING_STATUS.error]: "error",
};
