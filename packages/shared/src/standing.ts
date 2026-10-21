/**
 * Standing tasks, the office's recurring tasks: work an office agent does
 * again and again, rather than once to a pull request, and the one rule about
 * who may set one up.
 *
 * Three kinds:
 *
 * - **`pr-review`**, "watch for new pull requests": the runner polls GitHub's
 *   open pull requests, and each new one, from a collaborator or the runner's
 *   own agents and not a draft, is reviewed once by a fresh, short, read-only
 *   agent run, whose review the runner posts as a comment. Never an approval
 *   or a request for changes.
 * - **`pr-steward`**, "review, resolve conflicts and merge new pull
 *   requests": the watch's review, and then, for the same pull requests, a
 *   run that merges the base branch in and resolves its conflicts, and a merge
 *   once **every required check is green**. The runner decides the merge
 *   itself from GitHub's checks ({@link mergeGate}), never an agent, and never
 *   merges a pull request with a failing, pending or missing check.
 * - **`schedule`**, a recurring job: on a cron schedule (`./cron.ts`) the
 *   runner starts a fresh, short agent run with the CEO's instruction, and the
 *   AI Manager says what came of it.
 *
 * A task runs on any free slot, or, set up with a standing hire, on its own
 * agent's slot alone ({@link StandingSpecBase.agent}). Each run is kept with
 * its log, result and summary ({@link StandingRunRecord}), for the recurring
 * tasks' wall board.
 *
 * The runner owns a task once it has it: its definition, its trigger, its
 * record of what it handled and its spend, on its own disk. The server owns
 * who may create, pause, resume, remove and check one, which is
 * {@link mayManageStandingTasks}, the CEO, from the roster's buttons and
 * through the AI Manager alike. Every run is capped in minutes, and in money
 * and runs an hour only where its definition says so, by {@link StandingCaps},
 * and the runner caps them again itself whatever a definition says.
 *
 * Shared because a definition crosses the runner link as a command, a task's
 * state crosses back on every sync, and the client asks the same rule as the
 * server to grey out a button.
 */

import { MAX_MANAGER_MESSAGE_LENGTH } from "./constants.js";
import { parseCron, scheduleRefusal } from "./cron.js";
import { sanitizeManagerText, sanitizeTitle } from "./messages.js";
import { asRecord, truncate } from "./text.js";
import type { OfficeActor } from "./work.js";

/** What a standing task does. */
export const STANDING_KIND = {
  /** Reviews each new pull request once. */
  prReview: "pr-review",
  /** Reviews each new pull request once, resolves its conflicts, and merges it once every required check is green. */
  prSteward: "pr-steward",
  /** Runs the CEO's instruction on a cron schedule. */
  schedule: "schedule",
} as const;

export type StandingKind = (typeof STANDING_KIND)[keyof typeof STANDING_KIND];

/** Whether a kind watches the pull requests: the office holds one such task at most, so no pull request is reviewed twice. */
export function watchesPullRequests(kind: string): boolean {
  return kind === STANDING_KIND.prReview || kind === STANDING_KIND.prSteward;
}

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
  /** The runner's standing budget, or its own daily budget, is spent. */
  overBudget: "over-budget",
  /** It started the runs an hour it was set, so it starts nothing more until that hour has passed. */
  runLimit: "run-limit",
  /** Its last check or run went wrong. */
  error: "error",
} as const;

export type StandingStatus = (typeof STANDING_STATUS)[keyof typeof STANDING_STATUS];

/** What came of one run, or one event a task looked at. */
export const STANDING_OUTCOME = {
  /** A real review was posted on the pull request. */
  reviewed: "reviewed",
  /** The base branch was merged into the pull request, its conflicts resolved, and pushed. */
  resolved: "resolved",
  /** The pull request was merged, every required check green. */
  merged: "merged",
  /** A scheduled run finished, with its result. */
  completed: "completed",
  /** The mock agent's pretend run: nothing was posted or done. */
  simulated: "simulated",
  failed: "failed",
  /** Left alone: an outside contributor's pull request, a firing missed while it could not run, or a pull request not merged for its checks. */
  skipped: "skipped",
  /** Issue work took its slot; it runs again later. */
  preempted: "preempted",
  /** Not started: a budget is spent. */
  refusedBudget: "refused-budget",
} as const;

export type StandingOutcome = (typeof STANDING_OUTCOME)[keyof typeof STANDING_OUTCOME];

/**
 * Why a runner takes no standing tasks at all, as it says on every sync, so
 * the office can say so before it asks. Only a runner from before an unset
 * `RUNNER_STANDING_DAILY_BUDGET_USD` meant no cap still says it.
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

/** Runs kept of each task, with their logs, for the wall board; newest first. */
export const MAX_STANDING_HISTORY = 10;

/** How often a pull request task checks by default, and at most. */
export const DEFAULT_STANDING_INTERVAL_SECONDS = 120;
export const MIN_STANDING_INTERVAL_SECONDS = 60;
export const MAX_STANDING_INTERVAL_SECONDS = 24 * 60 * 60;

/**
 * What one run of a task may spend and take, and how often it may run. A
 * task has no daily spend of its own: standing tasks together are held to
 * `RUNNER_STANDING_DAILY_BUDGET_USD`, and only while it is set. Left out, a
 * run's spend and a task's runs an hour are not capped, as an unset budget
 * is not; its minutes always are, so a stuck run cannot hold its slot.
 */
export interface StandingCaps {
  /** US dollars one run may spend before it is stopped; left out, no cap but the budgets. */
  readonly perRunUsd?: number;
  /** Minutes one run may take before it is stopped: the safety net every run keeps. */
  readonly runMinutes: number;
  /** Runs the task may start in any hour; left out, as many as its trigger asks for. */
  readonly maxRunsPerHour?: number;
}

/** What a task the CEO set no caps for gets: only the minutes. */
export const DEFAULT_STANDING_CAPS: StandingCaps = { runMinutes: 10 };

/** The most a definition may ask for; the runner may hold a task to less. */
export const MAX_STANDING_CAPS: Required<StandingCaps> = { perRunUsd: 5, runMinutes: 30, maxRunsPerHour: 12 };

export interface StandingSpecBase {
  /** The server's id for it, {@link isStandingTaskId}: in the posted comment's marker, so never reused. */
  readonly id: string;
  readonly name: string;
  readonly paused: boolean;
  /** The CEO's words, given to every run as context; `""` for none. */
  readonly note: string;
  /** Bumped by an edit, so the runner keeps the newest definition. */
  readonly version: number;
  readonly caps: StandingCaps;
  /**
   * The runner's slot it runs on alone: the agent hired for it. Left out, it
   * runs on any free slot that is no other task's own.
   */
  readonly agent?: string | undefined;
}

export interface PrReviewSpec extends StandingSpecBase {
  readonly kind: typeof STANDING_KIND.prReview;
  /** Seconds between checks, from {@link MIN_STANDING_INTERVAL_SECONDS}. Drafts are always skipped. */
  readonly intervalSeconds: number;
  readonly authors: StandingAuthors;
}

/**
 * Collaborators' and the runner's own agents' pull requests only, whatever
 * else: an outside contributor's is never pushed to or merged.
 */
export interface PrStewardSpec extends StandingSpecBase {
  readonly kind: typeof STANDING_KIND.prSteward;
  /** Seconds between checks, from {@link MIN_STANDING_INTERVAL_SECONDS}. Drafts are always skipped. */
  readonly intervalSeconds: number;
}

export interface ScheduleSpec extends StandingSpecBase {
  readonly kind: typeof STANDING_KIND.schedule;
  /** Five-field cron, on the runner's clock; see `./cron.ts`. */
  readonly cron: string;
  /** What each run is to do, in the CEO's words. */
  readonly instruction: string;
}

export type StandingTaskSpec = PrReviewSpec | PrStewardSpec | ScheduleSpec;

/** A task's id: short, since it rides in every report and every comment's marker. */
const STANDING_ID = /^st-[a-z0-9]{4,16}$/;

/** Whether a value is a standing task's id. */
export function isStandingTaskId(value: unknown): value is string {
  return typeof value === "string" && STANDING_ID.test(value);
}

/** A runner slot's id, as `./runner.ts`'s `isRunnerName` takes one; not imported, since that module imports this one. */
const SLOT_ID = /^[A-Za-z0-9._-]{1,32}$/;

/** What a standing task is called when nobody named it. */
export const PR_REVIEW_TASK_NAME = "Watch for new pull requests";

/** What the pull request steward is called when nobody named it. */
export const PR_STEWARD_TASK_NAME = "Review, fix and merge pull requests";

/** A task name, one line of at most {@link MAX_STANDING_NAME_LENGTH} code points. */
export function sanitizeStandingName(raw: unknown): string {
  return truncate(sanitizeTitle(raw), MAX_STANDING_NAME_LENGTH).trim();
}

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function isWhole(value: unknown, min: number, max: number): value is number {
  return inRange(value, min, max) && Number.isInteger(value);
}

/** `undefined` for caps that are not, or ask for more than {@link MAX_STANDING_CAPS}; a cap left out stays out. */
export function parseStandingCaps(raw: unknown): StandingCaps | undefined {
  const caps = asRecord(raw);
  if (caps === undefined) {
    return undefined;
  }
  const { perRunUsd, runMinutes, maxRunsPerHour } = caps;
  const usd = perRunUsd === undefined ? {} : inRange(perRunUsd, 0.01, MAX_STANDING_CAPS.perRunUsd) ? { perRunUsd } : undefined;
  const hourly = maxRunsPerHour === undefined ? {} : isWhole(maxRunsPerHour, 1, MAX_STANDING_CAPS.maxRunsPerHour) ? { maxRunsPerHour } : undefined;
  if (!isWhole(runMinutes, 1, MAX_STANDING_CAPS.runMinutes) || usd === undefined || hourly === undefined) {
    return undefined;
  }
  return { ...usd, runMinutes, ...hourly };
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
  const agent = spec["agent"] ?? undefined;
  if (agent !== undefined && !(typeof agent === "string" && SLOT_ID.test(agent))) {
    return undefined;
  }
  const base = { id: spec["id"], paused: spec["paused"], note, version: spec["version"], caps, ...(agent === undefined ? {} : { agent }) };
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
    case STANDING_KIND.prSteward: {
      const { intervalSeconds } = spec;
      if (!isWhole(intervalSeconds, MIN_STANDING_INTERVAL_SECONDS, MAX_STANDING_INTERVAL_SECONDS)) {
        return undefined;
      }
      const name = sanitizeStandingName(spec["name"]) || PR_STEWARD_TASK_NAME;
      return { ...base, kind: STANDING_KIND.prSteward, name, intervalSeconds };
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

/** How often a task runs, as the CEO changes it from the wall board: a schedule's cron, or a pull request task's seconds between checks. */
export type StandingSchedule = { readonly cron: string } | { readonly intervalSeconds: number };

/**
 * A new schedule, proved as a definition's would be: a cron no more often than
 * `./cron.ts` allows, or whole seconds between checks inside the limits.
 *
 * @returns it, its cron in canonical form, or `undefined` for one that is not.
 */
export function parseStandingSchedule(raw: unknown): StandingSchedule | undefined {
  const schedule = asRecord(raw);
  if (schedule === undefined) {
    return undefined;
  }
  if (typeof schedule["cron"] === "string" && schedule["intervalSeconds"] === undefined) {
    const cron = schedule["cron"].trim().replace(/\s+/g, " ");
    return scheduleRefusal(cron) === undefined ? { cron: parseCron(cron)?.expression ?? cron } : undefined;
  }
  const { intervalSeconds } = schedule;
  return schedule["cron"] === undefined && isWhole(intervalSeconds, MIN_STANDING_INTERVAL_SECONDS, MAX_STANDING_INTERVAL_SECONDS)
    ? { intervalSeconds }
    : undefined;
}

/** A definition with a new schedule, or `undefined` when the schedule is not one its kind takes. */
export function rescheduled(spec: StandingTaskSpec, schedule: StandingSchedule): StandingTaskSpec | undefined {
  if (spec.kind === STANDING_KIND.schedule) {
    return "cron" in schedule ? { ...spec, cron: schedule.cron, version: spec.version + 1 } : undefined;
  }
  return "intervalSeconds" in schedule ? { ...spec, intervalSeconds: schedule.intervalSeconds, version: spec.version + 1 } : undefined;
}

/**
 * Whether an actor may create, pause, resume, remove or check a standing
 * task, or change how often it runs. **The one gate.** A standing task spends money unattended, so it is
 * the CEO's, as handing out work is. The server checks it on every message
 * and every plan of the AI Manager's; the client asks it only to disable a
 * button and say why.
 */
export function mayManageStandingTasks(actor: OfficeActor): boolean {
  return actor.isCeo;
}

/** One check on a pull request's head commit, as GitHub reports it: a check run or a commit status. */
export interface PullCheck {
  readonly name: string;
  readonly state: "pass" | "fail" | "pending" | "skipped";
  /** Whether the base branch's protection requires it. */
  readonly required: boolean;
}

/** A pull request as the steward inspects it before it resolves or merges anything. */
export interface PullState {
  readonly open: boolean;
  readonly draft: boolean;
  readonly headSha: string;
  readonly headRef: string;
  readonly baseRef: string;
  /** From a fork, which the runner cannot push to. */
  readonly crossRepository: boolean;
  /** GitHub's `mergeable`: `MERGEABLE`, `CONFLICTING` or `UNKNOWN` while it works it out. */
  readonly mergeable: string;
  /** GitHub's `mergeStateStatus`: `CLEAN`, `UNSTABLE`, `BLOCKED`, `BEHIND`, `DIRTY`, `HAS_HOOKS`, `UNKNOWN`, `DRAFT`. */
  readonly mergeState: string;
  readonly checks: readonly PullCheck[];
  /** GitHub had more checks than were read: never merged on part of them. */
  readonly checksTruncated: boolean;
}

/**
 * Whether a pull request's checks let the steward merge it: **every required
 * check green, and no check failing**, required or not. Every check on the
 * head commit counts; a skipped one is passed over, and at least one must
 * have passed, so a pull request with no checks at all is never merged.
 * **The one rule** for a merge: the runner asks it before it queues one and
 * again just before it merges.
 *
 * @returns `undefined` when they do, or why not in a few words, and whether
 * it is only a check still running.
 */
export function mergeGate(checks: readonly PullCheck[], truncated: boolean): { readonly why: string; readonly pending: boolean } | undefined {
  if (truncated) {
    return { why: "it has more checks than the runner reads", pending: false };
  }
  const counted = checks.filter((check) => check.state !== "skipped");
  if (counted.length === 0) {
    return { why: checks.length > 0 ? "every check was skipped" : "it has no checks", pending: false };
  }
  const failing = counted.find((check) => check.state === "fail");
  if (failing !== undefined) {
    return { why: `the check “${failing.name}” failed`, pending: false };
  }
  const pending = counted.find((check) => check.state === "pending");
  return pending === undefined ? undefined : { why: `the check “${pending.name}” has not finished`, pending: true };
}

/** What the steward does next about one pull request, as {@link stewardStep} reads it. */
export type StewardStep =
  /** Every required check green and nothing in the way. */
  | { readonly kind: "merge" }
  /** Conflicts with its base, or behind it where the base must be merged in first. */
  | { readonly kind: "resolve" }
  /** Nothing to do yet: checks running, or GitHub still working out whether it merges. */
  | { readonly kind: "wait"; readonly why: string }
  /**
   * Not merged yet, for a reason said once a head: a failed check, a rule
   * GitHub enforces, a fork's conflicts. Only said: the steward keeps
   * looking, and merges once the reason is gone.
   */
  | { readonly kind: "hold"; readonly why: string };

/** The merge states the steward merges in: clean, or pre-receive hooks; never `UNSTABLE`, a check failing. */
const MERGEABLE_STATES: ReadonlySet<string> = new Set(["CLEAN", "HAS_HOOKS"]);

/**
 * The steward's next step for an open pull request it has reviewed. A merge
 * needs both {@link mergeGate} and GitHub's own merge state, so a required
 * check that has not even started (GitHub says `BLOCKED`) still holds it.
 */
export function stewardStep(state: PullState): StewardStep {
  if (!state.open || state.draft) {
    return { kind: "wait", why: state.open ? "it is a draft" : "it is closed" };
  }
  if (state.mergeable === "CONFLICTING" || state.mergeState === "DIRTY" || state.mergeState === "BEHIND") {
    return state.crossRepository
      ? { kind: "hold", why: "it is from a fork, which the runner cannot push to, so its author has to bring it up to date" }
      : { kind: "resolve" };
  }
  if (state.mergeable !== "MERGEABLE") {
    return { kind: "wait", why: "GitHub is still working out whether it merges" };
  }
  const gate = mergeGate(state.checks, state.checksTruncated);
  if (gate !== undefined) {
    return { kind: gate.pending ? "wait" : "hold", why: gate.why };
  }
  if (!MERGEABLE_STATES.has(state.mergeState)) {
    return state.mergeState === "BLOCKED"
      ? { kind: "hold", why: "GitHub blocks the merge for now: a required check has not reported yet, or the branch's rules want more, such as an approving review" }
      : { kind: "wait", why: `GitHub says its merge state is ${state.mergeState.toLowerCase()}` };
  }
  return { kind: "merge" };
}

/** What the CEO can do to a standing task from the roster or through the AI Manager. */
export const STANDING_ACTION = {
  create: "create",
  pause: "pause",
  resume: "resume",
  remove: "remove",
  checkNow: "check-now",
  /** How often it runs, from the wall board; it carries its {@link StandingSchedule}. */
  reschedule: "reschedule",
} as const;

export type StandingAction = (typeof STANDING_ACTION)[keyof typeof STANDING_ACTION];

/** The actions on a task that exists that carry nothing but its id, which the roster's and the wall board's buttons send. */
export type StandingTaskAction = Exclude<StandingAction, typeof STANDING_ACTION.create | typeof STANDING_ACTION.reschedule>;

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
  /** The office already watches for new pull requests, with the watch or the steward. */
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
  /** The pull request it was about, for a pull request task. */
  readonly pr?: number | undefined;
}

/**
 * One run of a task, kept whole for the wall board: when it ran, who ran it,
 * what came of it and what it cost, a one-line summary, its result (a
 * schedule's report, a review's text, why it failed), and the tail of what it
 * wrote on its slot's screen, as plain text. Everything in it is what every
 * visitor may read: the screen it comes off is broadcast already, masked the
 * same way.
 */
export interface StandingRunRecord {
  /** The runner's id for it; the server keeps it once. */
  readonly id: string;
  readonly taskId: string;
  /** Epoch ms. */
  readonly startedAt: number;
  readonly endedAt: number;
  readonly outcome: StandingOutcome;
  readonly pr: { readonly number: number; readonly title: string } | undefined;
  /** The name of the agent that ran it; `""` for something looked at with no run. */
  readonly agent: string;
  readonly costUsd: number;
  /** One line. */
  readonly summary: string;
  readonly result: string;
  readonly log: string;
  /** The review comment it posted, on GitHub. */
  readonly commentId: number | undefined;
}

/** Longest summary, result and log a run record carries, in bytes. */
export const MAX_STANDING_SUMMARY_BYTES = 200;
export const MAX_STANDING_RESULT_BYTES = 2000;
export const MAX_STANDING_LOG_BYTES = 4000;

/** One standing task, as its runner reports it on every sync. */
export interface StandingTaskReport {
  readonly id: string;
  readonly kind: StandingKind;
  readonly name: string;
  readonly status: StandingStatus;
  /** Its trigger in a few words: `every 2 min`, `weekdays 09:00`. */
  readonly trigger: string;
  /** How often it runs, for the wall board's schedule control to start from. */
  readonly schedule: StandingSchedule;
  /** The slot it runs on alone, a standing hire's; `undefined` for any free slot. */
  readonly agent: string | undefined;
  /** Epoch ms of its last check of GitHub or firing; `undefined` before the first. */
  readonly lastCheckAt: number | undefined;
  /** Epoch ms of its next; `undefined` while paused, over budget or at its run limit. */
  readonly nextCheckAt: number | undefined;
  /** Events waiting for a slot. */
  readonly queued: number;
  /** Runs that ended today. */
  readonly handledToday: number;
  readonly spentTodayUsd: number;
  /** The runner's standing budget it is held to today; `undefined` for none, when nothing caps what it spends. */
  readonly dailyUsd: number | undefined;
  /** Its last error, short; `""` when there is none. */
  readonly lastError: string;
  /** Newest first, at most {@link MAX_STANDING_RECENT}. */
  readonly recent: readonly StandingRunSummary[];
}

/** Longest task name a report or event carries, in bytes. */
export const MAX_STANDING_NAME_BYTES = 64;

/** Longest trigger description, in bytes. */
export const MAX_STANDING_TRIGGER_BYTES = 24;

/** Longest cron a report carries, in bytes. */
export const MAX_STANDING_CRON_BYTES = 64;

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
  [STANDING_OUTCOME.resolved]: "conflicts resolved",
  [STANDING_OUTCOME.merged]: "merged",
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
  [STANDING_STATUS.runLimit]: "run limit reached",
  [STANDING_STATUS.error]: "error",
};
