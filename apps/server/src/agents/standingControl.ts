/**
 * What the office does about standing tasks, the recurring tasks: set one up
 * on a runner, and pause, resume, remove, check or reschedule one, for the
 * CEO alone.
 *
 * The one gate is `mayManageStandingTasks` in `@sim/shared`, asked here for
 * every action, whether it came from the roster's buttons
 * (`../rooms/standingHandlers.ts`) or from the AI Manager acting on the CEO's
 * words (`../manager/officeManager.ts`), so neither can do what the other
 * could not. What passes becomes a command for the runner holding the task,
 * which still has the last word: it refuses a definition past its own limits,
 * and a real agent's runner takes none until its operator sets a standing
 * budget. The server never writes to GitHub, starts a process or holds a
 * credential for one: the runner does every run and posts every comment.
 *
 * A new task goes to the first runner that takes standing tasks and has room
 * for one, as the mirror (`./standingMirror.ts`) last heard, or, set up with
 * a standing hire (`../manager/hire.ts`), to the runner the new agent was
 * hired onto, to run on that agent's slot alone. Synchronous and small: it
 * queues a command and says what it did, so a message handler or the
 * manager's answer can call it between ticks.
 */

import { randomBytes } from "node:crypto";

import {
  DEFAULT_STANDING_CAPS,
  DEFAULT_STANDING_INTERVAL_SECONDS,
  MAX_STANDING_TASKS,
  type OfficeActor,
  PR_REVIEW_TASK_NAME,
  PR_STEWARD_TASK_NAME,
  RUNNER_COMMAND_KIND,
  type RunnerCommand,
  type RunnerCommandDraft,
  STANDING_ACTION,
  STANDING_AUTHORS,
  STANDING_KIND,
  STANDING_OFF,
  STANDING_REJECTION,
  type StandingRejection,
  type StandingSchedule,
  type StandingTaskAction,
  type StandingTaskSpec,
  describeCron,
  formatUsd,
  mayManageStandingTasks,
  parseCron,
  sanitizeManagerText,
  sanitizeStandingName,
  scheduleRefusal,
  watchesPullRequests,
} from "@sim/shared";

import { StandingMirror, type StandingTaskRecord } from "./standingMirror.js";

/** What the control needs of the mirror. */
export type StandingDirectory = Pick<StandingMirror, "standingTasks" | "runnerViews" | "watchesPullRequests" | "expect" | "forgetRuns">;

/** What the control needs of the runner link. */
export interface StandingCommands {
  enqueue(runnerId: string, draft: RunnerCommandDraft): RunnerCommand | undefined;
}

/** A new standing task, as the CEO asked for it. */
export type StandingRequest =
  | { readonly kind: typeof STANDING_KIND.prReview }
  | { readonly kind: typeof STANDING_KIND.prSteward }
  | { readonly kind: typeof STANDING_KIND.schedule; readonly cron: string; readonly instruction: string };

export type StandingResult =
  | { readonly ok: true; readonly text: string; readonly taskId: string }
  | { readonly ok: false; readonly rejection: StandingRejection; readonly text: string };

export type StandingRefusal = Extract<StandingResult, { readonly ok: false }>;

/** Where a task set up with a standing hire goes: the runner its agent was hired onto, and the agent's slot. */
export interface StandingPlacement {
  readonly runnerId: string;
  readonly agent: string;
}

/** Why the office did nothing, in the AI Manager's words and the roster's. */
const STANDING_REJECTION_TEXT: Readonly<Record<StandingRejection, string>> = {
  [STANDING_REJECTION.forbidden]: "Only the CEO can set up, pause, resume, remove or check a standing task.",
  [STANDING_REJECTION.unknownTask]: "There's no standing task like that.",
  [STANDING_REJECTION.noRunner]: "No agent runner is connected, so there is nobody to give a standing task to.",
  [STANDING_REJECTION.runnerRefuses]:
    "The runner takes no standing tasks: its agents are real, and its operator has not set RUNNER_STANDING_DAILY_BUDGET_USD, which it needs before it spends anything unattended.",
  [STANDING_REJECTION.full]: `Every runner already holds ${MAX_STANDING_TASKS} standing tasks; remove one first.`,
  [STANDING_REJECTION.duplicate]:
    "I'm already watching for new pull requests. To change how, remove that task first (say “stop watching pull requests”), then ask again.",
  [STANDING_REJECTION.unreachable]: "The runner could not be given that; it may be offline. Try again shortly.",
  [STANDING_REJECTION.invalid]: "That isn't a standing task a runner can take.",
};

export interface StandingControlOptions {
  readonly directory: StandingDirectory;
  readonly commands: StandingCommands;
  /** Task ids. Injected so a test can name the tasks it expects. */
  readonly taskId?: () => string;
}

function refuse(rejection: StandingRejection, text = STANDING_REJECTION_TEXT[rejection]): StandingRefusal {
  return { ok: false, rejection, text };
}

/** How often a task runs, in words: `weekdays 09:00`, `every 10 min`. */
export function scheduleText(schedule: StandingSchedule): string {
  if ("cron" in schedule) {
    const cron = parseCron(schedule.cron);
    return cron === undefined ? `on cron ${schedule.cron}` : describeCron(cron);
  }
  const minutes = schedule.intervalSeconds / 60;
  return Number.isInteger(minutes) ? `every ${minutes} min` : `every ${schedule.intervalSeconds} s`;
}

/** The caps of a run, in words: `at most 10 minutes a run`, `at most $0.50 and 10 minutes a run, 6 runs an hour`. */
function capsText(spec: StandingTaskSpec): string {
  const { caps } = spec;
  const usd = caps.perRunUsd === undefined ? "" : `${formatUsd(caps.perRunUsd)} and `;
  return `at most ${usd}${caps.runMinutes} minutes a run${caps.maxRunsPerHour === undefined ? "" : `, ${caps.maxRunsPerHour} runs an hour`}`;
}

export class StandingControl {
  private readonly taskId: () => string;

  public constructor(private readonly options: StandingControlOptions) {
    this.taskId = options.taskId ?? (() => `st-${randomBytes(4).toString("hex")}`);
  }

  /** Every task in the office, as the mirror last heard. */
  public tasks(): readonly StandingTaskRecord[] {
    return this.options.directory.standingTasks();
  }

  /**
   * The runner a new task would go to, for the CEO, or why none would take
   * it: what a standing hire asks before it hires anyone.
   */
  public place(actor: OfficeActor, request: StandingRequest): { readonly ok: true; readonly runnerId: string } | StandingRefusal {
    if (!mayManageStandingTasks(actor)) {
      return refuse(STANDING_REJECTION.forbidden);
    }
    const { directory } = this.options;
    if (watchesPullRequests(request.kind) && directory.watchesPullRequests()) {
      return refuse(STANDING_REJECTION.duplicate);
    }
    if (request.kind === STANDING_KIND.schedule) {
      const why = scheduleRefusal(request.cron);
      if (why !== undefined) {
        return refuse(STANDING_REJECTION.invalid, `I can't schedule that: ${why}.`);
      }
    }
    const runners = directory.runnerViews();
    if (runners.length === 0) {
      return refuse(STANDING_REJECTION.noRunner);
    }
    const home = runners.find((runner) => StandingMirror.hasRoom(runner));
    if (home === undefined) {
      return refuse(runners.every((runner) => runner.off === STANDING_OFF.noBudget) ? STANDING_REJECTION.runnerRefuses : STANDING_REJECTION.full);
    }
    return { ok: true, runnerId: home.runnerId };
  }

  /**
   * Sets a new task up on a runner with room for it, for the CEO: the first,
   * or, with a `placement`, the one its hired agent is on, to run there on
   * that agent's slot alone.
   */
  public create(actor: OfficeActor, requestedBy: string, request: StandingRequest, note: string, placement?: StandingPlacement): StandingResult {
    const placed = this.place(actor, request);
    if (!placed.ok) {
      return placed;
    }
    const { directory } = this.options;
    const runnerId = placement?.runnerId ?? placed.runnerId;
    const home = directory.runnerViews().find((runner) => runner.runnerId === runnerId);
    if (home === undefined || !StandingMirror.hasRoom(home)) {
      return refuse(home?.off === STANDING_OFF.noBudget ? STANDING_REJECTION.runnerRefuses : STANDING_REJECTION.full);
    }
    const spec = this.specFor(request, note, placement?.agent);
    if (spec === undefined) {
      return refuse(STANDING_REJECTION.invalid);
    }
    const command = this.options.commands.enqueue(runnerId, { kind: RUNNER_COMMAND_KIND.standingSet, spec, requestedBy });
    if (command === undefined) {
      return refuse(STANDING_REJECTION.unreachable);
    }
    directory.expect(runnerId, spec.id, spec.kind);
    if (spec.kind === STANDING_KIND.prSteward) {
      return {
        ok: true,
        taskId: spec.id,
        text:
          `✓ “${spec.name}” is set up on ${runnerId}: each new pull request from a collaborator or our own agents gets one read-only review, ` +
          "then its base is merged in and its conflicts resolved when it has them, and it is merged once every required check is green: " +
          `never with a check failing, still running or missing. ${capsText(spec).charAt(0).toUpperCase()}${capsText(spec).slice(1)}. ` +
          "The pull requests open now are left alone, drafts wait until they're ready, and GitHub's own branch rules still apply.",
      };
    }
    if (spec.kind === STANDING_KIND.prReview) {
      return {
        ok: true,
        taskId: spec.id,
        text:
          `✓ “${spec.name}” is set up on ${runnerId}: it keeps looking for new pull requests, ` +
          `and each one from a collaborator or our own agents gets one read-only review comment, ${capsText(spec)}. ` +
          "The pull requests open now are left alone, and drafts wait until they're ready.",
      };
    }
    const schedule = parseCron(spec.cron);
    const when = schedule === undefined ? spec.cron : describeCron(schedule);
    return {
      ok: true,
      taskId: spec.id,
      text: `✓ Scheduled “${spec.name}” on ${runnerId}: ${when} on the runner's clock, ${capsText(spec)}. I'll say what each run finds.`,
    };
  }

  /** Changes how often a task runs, for the CEO: a schedule's cron, or a pull request task's minutes between checks. */
  public reschedule(actor: OfficeActor, requestedBy: string, taskId: string, schedule: StandingSchedule): StandingResult {
    if (!mayManageStandingTasks(actor)) {
      return refuse(STANDING_REJECTION.forbidden);
    }
    const record = this.tasks().find((candidate) => candidate.report.id === taskId);
    if (record === undefined) {
      return refuse(STANDING_REJECTION.unknownTask);
    }
    const isSchedule = record.report.kind === STANDING_KIND.schedule;
    if (isSchedule !== "cron" in schedule) {
      return refuse(
        STANDING_REJECTION.invalid,
        isSchedule ? "A scheduled job runs on a schedule, like “every weekday at 9”." : "A pull request task checks every so many minutes.",
      );
    }
    const command = this.options.commands.enqueue(record.runnerId, { kind: RUNNER_COMMAND_KIND.standingReschedule, taskId, schedule, requestedBy });
    if (command === undefined) {
      return refuse(STANDING_REJECTION.unreachable);
    }
    return { ok: true, taskId, text: `✓ “${record.report.name}” now runs ${scheduleText(schedule)}.` };
  }

  /** Pauses, resumes, removes or checks one task, for the CEO. */
  public act(actor: OfficeActor, requestedBy: string, action: StandingTaskAction, taskId: string): StandingResult {
    if (!mayManageStandingTasks(actor)) {
      return refuse(STANDING_REJECTION.forbidden);
    }
    const record = this.tasks().find((candidate) => candidate.report.id === taskId);
    if (record === undefined) {
      return refuse(STANDING_REJECTION.unknownTask);
    }
    const runnerOff = this.options.directory.runnerViews().some((runner) => runner.runnerId === record.runnerId && runner.off !== undefined);
    if (runnerOff && (action === STANDING_ACTION.resume || action === STANDING_ACTION.checkNow)) {
      return refuse(STANDING_REJECTION.runnerRefuses);
    }
    const kind = {
      [STANDING_ACTION.pause]: RUNNER_COMMAND_KIND.standingPause,
      [STANDING_ACTION.resume]: RUNNER_COMMAND_KIND.standingResume,
      [STANDING_ACTION.remove]: RUNNER_COMMAND_KIND.standingRemove,
      [STANDING_ACTION.checkNow]: RUNNER_COMMAND_KIND.standingCheckNow,
    }[action];
    const command = this.options.commands.enqueue(record.runnerId, { kind, taskId, requestedBy });
    if (command === undefined) {
      return refuse(STANDING_REJECTION.unreachable);
    }
    if (action === STANDING_ACTION.remove) {
      this.options.directory.forgetRuns(taskId);
    }
    const name = `“${record.report.name}”`;
    const text = {
      [STANDING_ACTION.pause]: `✓ Paused ${name}: it checks nothing until you resume it.`,
      [STANDING_ACTION.resume]: `✓ Resumed ${name}.`,
      [STANDING_ACTION.remove]: `✓ Removed ${name}; a run of it under way is stopped.`,
      [STANDING_ACTION.checkNow]:
        record.report.kind === STANDING_KIND.schedule ? `✓ ${name} runs now.` : `✓ ${name} looks for new pull requests now.`,
    }[action];
    return { ok: true, text, taskId };
  }

  private specFor(request: StandingRequest, note: string, agent: string | undefined): StandingTaskSpec | undefined {
    const base = {
      id: this.taskId(),
      paused: false,
      note: sanitizeManagerText(note),
      version: 1,
      caps: DEFAULT_STANDING_CAPS,
      ...(agent === undefined ? {} : { agent }),
    };
    if (request.kind === STANDING_KIND.prSteward) {
      return { ...base, kind: STANDING_KIND.prSteward, name: PR_STEWARD_TASK_NAME, intervalSeconds: DEFAULT_STANDING_INTERVAL_SECONDS };
    }
    if (request.kind === STANDING_KIND.prReview) {
      return {
        ...base,
        kind: STANDING_KIND.prReview,
        name: PR_REVIEW_TASK_NAME,
        intervalSeconds: DEFAULT_STANDING_INTERVAL_SECONDS,
        authors: STANDING_AUTHORS.collaborators,
      };
    }
    const instruction = sanitizeManagerText(request.instruction);
    const schedule = parseCron(request.cron);
    if (instruction === "" || schedule === undefined) {
      return undefined;
    }
    const named = sanitizeStandingName(instruction);
    const name = named.charAt(0).toUpperCase() + named.slice(1);
    // The instruction is the job, so the CEO's note is not said twice.
    return { ...base, note: "", kind: STANDING_KIND.schedule, name, cron: schedule.expression, instruction };
  }
}
