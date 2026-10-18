/**
 * What the office does about standing tasks: set one up on a runner, and
 * pause, resume, remove or check one, for the CEO alone.
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
 * for one, as the mirror (`./standingMirror.ts`) last heard. Synchronous and
 * small: it queues a command and says what it did, so a message handler or
 * the manager's answer can call it between ticks.
 */

import { randomBytes } from "node:crypto";

import {
  DEFAULT_STANDING_CAPS,
  DEFAULT_STANDING_INTERVAL_SECONDS,
  MAX_STANDING_TASKS,
  type OfficeActor,
  PR_REVIEW_TASK_NAME,
  RUNNER_COMMAND_KIND,
  type RunnerCommand,
  type RunnerCommandDraft,
  STANDING_ACTION,
  STANDING_AUTHORS,
  STANDING_KIND,
  STANDING_OFF,
  STANDING_REJECTION,
  type StandingRejection,
  type StandingTaskAction,
  type StandingTaskSpec,
  describeCron,
  formatUsd,
  mayManageStandingTasks,
  parseCron,
  sanitizeManagerText,
  sanitizeStandingName,
  scheduleRefusal,
} from "@sim/shared";

import { StandingMirror, type StandingTaskRecord } from "./standingMirror.js";

/** What the control needs of the mirror. */
export type StandingDirectory = Pick<StandingMirror, "standingTasks" | "runnerViews" | "hasKind" | "expect">;

/** What the control needs of the runner link. */
export interface StandingCommands {
  enqueue(runnerId: string, draft: RunnerCommandDraft): RunnerCommand | undefined;
}

/** A new standing task, as the CEO asked for it. */
export type StandingRequest =
  | { readonly kind: typeof STANDING_KIND.prReview }
  | { readonly kind: typeof STANDING_KIND.schedule; readonly cron: string; readonly instruction: string };

export type StandingResult =
  | { readonly ok: true; readonly text: string; readonly taskId: string }
  | { readonly ok: false; readonly rejection: StandingRejection; readonly text: string };

/** Why the office did nothing, in the AI Manager's words and the roster's. */
export const STANDING_REJECTION_TEXT: Readonly<Record<StandingRejection, string>> = {
  [STANDING_REJECTION.forbidden]: "Only the CEO can set up, pause, resume, remove or check a standing task.",
  [STANDING_REJECTION.unknownTask]: "There's no standing task like that.",
  [STANDING_REJECTION.noRunner]: "No agent runner is connected, so there is nobody to give a standing task to.",
  [STANDING_REJECTION.runnerRefuses]:
    "The runner takes no standing tasks: its agents are real, and its operator has not set RUNNER_STANDING_DAILY_BUDGET_USD, which it needs before it spends anything unattended.",
  [STANDING_REJECTION.full]: `Every runner already holds ${MAX_STANDING_TASKS} standing tasks; remove one first.`,
  [STANDING_REJECTION.duplicate]: "I'm already watching for new pull requests.",
  [STANDING_REJECTION.unreachable]: "The runner could not be given that; it may be offline. Try again shortly.",
  [STANDING_REJECTION.invalid]: "That isn't a standing task a runner can take.",
};

export interface StandingControlOptions {
  readonly directory: StandingDirectory;
  readonly commands: StandingCommands;
  /** Task ids. Injected so a test can name the tasks it expects. */
  readonly taskId?: () => string;
}

function refuse(rejection: StandingRejection, text = STANDING_REJECTION_TEXT[rejection]): StandingResult {
  return { ok: false, rejection, text };
}

/** The caps of a run, in words: `at most $0.50 and 10 minutes a run, and $2.00 a day`. */
function capsText(spec: StandingTaskSpec): string {
  const { caps } = spec;
  return `at most ${formatUsd(caps.perRunUsd)} and ${caps.runMinutes} minutes a run, and ${formatUsd(caps.dailyUsd)} a day`;
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

  /** Sets a new task up on a runner with room for it, for the CEO. */
  public create(actor: OfficeActor, requestedBy: string, request: StandingRequest, note: string): StandingResult {
    if (!mayManageStandingTasks(actor)) {
      return refuse(STANDING_REJECTION.forbidden);
    }
    const { directory } = this.options;
    if (request.kind === STANDING_KIND.prReview && directory.hasKind(STANDING_KIND.prReview)) {
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
    const spec = this.specFor(request, note);
    if (spec === undefined) {
      return refuse(STANDING_REJECTION.invalid);
    }
    const command = this.options.commands.enqueue(home.runnerId, { kind: RUNNER_COMMAND_KIND.standingSet, spec, requestedBy });
    if (command === undefined) {
      return refuse(STANDING_REJECTION.unreachable);
    }
    directory.expect(home.runnerId, spec.id, spec.kind);
    if (spec.kind === STANDING_KIND.prReview) {
      return {
        ok: true,
        taskId: spec.id,
        text:
          `✓ “${spec.name}” is set up on ${home.runnerId}: it keeps looking for new pull requests, ` +
          `and each one from a collaborator or our own agents gets one read-only review comment, ${capsText(spec)}. ` +
          "The pull requests open now are left alone, and drafts wait until they're ready.",
      };
    }
    const schedule = parseCron(spec.cron);
    const when = schedule === undefined ? spec.cron : describeCron(schedule);
    return {
      ok: true,
      taskId: spec.id,
      text: `✓ Scheduled “${spec.name}” on ${home.runnerId}: ${when} on the runner's clock, ${capsText(spec)}. I'll say what each run finds.`,
    };
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
    const name = `“${record.report.name}”`;
    const text = {
      [STANDING_ACTION.pause]: `✓ Paused ${name}: it checks nothing until you resume it.`,
      [STANDING_ACTION.resume]: `✓ Resumed ${name}.`,
      [STANDING_ACTION.remove]: `✓ Removed ${name}; a run of it under way is stopped.`,
      [STANDING_ACTION.checkNow]:
        record.report.kind === STANDING_KIND.prReview ? `✓ ${name} looks for new pull requests now.` : `✓ ${name} runs now.`,
    }[action];
    return { ok: true, text, taskId };
  }

  private specFor(request: StandingRequest, note: string): StandingTaskSpec | undefined {
    const base = { id: this.taskId(), paused: false, note: sanitizeManagerText(note), version: 1, caps: DEFAULT_STANDING_CAPS };
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
