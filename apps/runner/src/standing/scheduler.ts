/**
 * The runner's standing tasks: their definitions, their triggers, the ledger
 * of what each has handled, their caps, and the runs they start.
 *
 * A `pr-review` task polls GitHub's open pull requests (`./pulls.ts`) every
 * `intervalSeconds`. Its first look records every open pull request as
 * `baseline`, never reviewed; after that each new one is queued, unless it is
 * a draft, which waits until it is ready, or an outside contributor's, which
 * is skipped and said so. A `schedule` task queues a firing at each minute
 * its cron names, on this machine's clock; a firing it cannot start, paused
 * or over a cap, is missed rather than caught up.
 *
 * A `pr-steward` task reviews the same way, and then, on every check, looks
 * at each pull request it reviewed that is still open (`inspect`), asking
 * `stewardStep` in `@sim/shared` what next: a run that merges the base in and
 * resolves the conflicts, a merge once every required check is green, a
 * reason it is not merged, said once a head commit, or nothing yet. Each is
 * keyed by the head commit it was for, so a push starts it over, and the
 * merge run asks the gate again, on a fresh look, before it merges.
 *
 * A queued event starts a run on a slot holding no run of any kind, at most
 * `RUNNER_STANDING_MAX_CONCURRENT` at once and one per task: on the task's own
 * agent's slot alone, for a task set up with a standing hire, or else on any
 * free slot that is no task's own. A task whose own agent was fired goes with
 * it. Issue work
 * always comes first: an issue's start for a slot on a standing run takes the
 * slot back (`../slots.ts`), and the run's event is queued again without
 * counting an attempt. A failed run is tried again after a backoff, up to
 * {@link MAX_ATTEMPTS} in all; its failure is final, and said so, after the
 * last.
 *
 * Every run is held to its task's caps by the runner itself, whatever the
 * server sent: its own `dailyUsd` and `maxRunsPerHour` (reached within an
 * hour, it starts nothing more that day, so a burst cannot run up the day),
 * `RUNNER_STANDING_DAILY_BUDGET_USD` for every standing task together, and
 * the runner's own daily budget, in whose ledger standing spend is booked
 * too. A run is saved as `running` before its agent starts, so a restart
 * tries it again; a review's marker on the pull request (`./review.ts`) keeps
 * that from ever posting twice.
 *
 * Every run, and everything a task said it left alone, is kept as a record
 * with its summary, its result and the tail of what it wrote on its slot's
 * screen, for the recurring tasks' wall board; records wait in
 * `standing.json` until a sync carrying them is answered.
 *
 * Everything persists in `standing.json` (`./store.ts`). Events wait here
 * until a sync carrying them is answered, as a slot's do.
 */

import { randomUUID } from "node:crypto";

import {
  MAX_STANDING_ERROR_BYTES,
  MAX_STANDING_LOG_BYTES,
  MAX_STANDING_MESSAGE_BYTES,
  MAX_STANDING_NAME_BYTES,
  MAX_STANDING_RECENT,
  MAX_STANDING_RESULT_BYTES,
  MAX_STANDING_SUMMARY_BYTES,
  MAX_STANDING_TASKS,
  MAX_STANDING_TRIGGER_BYTES,
  MAX_TITLE_LENGTH,
  MAX_WORK_NOTE_LENGTH,
  RUNNER_COMMAND_KIND,
  RUNNER_EVENT_KIND,
  type RunnerEvent,
  type RunnerStandingCommand,
  STANDING_KIND,
  STANDING_OFF,
  STANDING_OUTCOME,
  STANDING_OUTCOME_TEXT,
  STANDING_STATUS,
  type StandingCaps,
  type StandingOff,
  type StandingOutcome,
  type StandingRunRecord,
  type StandingSchedule,
  type StandingStatus,
  type StandingTaskReport,
  type StandingTaskSpec,
  describeCron,
  formatUsd,
  jsonTextBytes,
  nextFire,
  parseCron,
  parseStandingTaskSpec,
  rescheduled,
  stewardStep,
  watchesPullRequests,
} from "@sim/shared";

import { type SpendLedger, localDay } from "../budget.js";
import { type Redactor, createRedactor } from "../redact.js";
import { STANDING_SLOT_END, type SlotPool, type StandingSlotLease, fitBytes } from "../slots.js";
import type { OpenPull, PullSource } from "./pulls.js";
import {
  LEDGER_STATE,
  type LedgerEntry,
  MAX_UNSENT_RUNS,
  type SkipReason,
  type StandingFile,
  type StandingStore,
  type StoredTask,
} from "./store.js";
import type { StandingRunResult, StandingRunners, StandingStep } from "./types.js";

/** Runs for one event, the first included. */
export const MAX_ATTEMPTS = 3;

/** Waits before the second and third attempts. */
const RETRY_BACKOFF_MS: readonly number[] = [60_000, 5 * 60_000];

/** How often the scheduler looks for a check, a firing or a run to start. */
const DEFAULT_TICK_MS = 1000;

/** A closed pull request's entry is forgotten this long after it was last seen open. */
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60_000;

/** Most entries one task's ledger keeps; the oldest settled ones go first. */
const MAX_LEDGER_ENTRIES = 500;

/** Most firings a schedule's ledger keeps. */
const MAX_SCHEDULE_ENTRIES = 20;

/** Events held while the server cannot be reached, as a slot pool holds them. */
const MAX_PENDING_EVENTS = 256;

/** At most one save a second while a run reports its spend. */
const SPEND_SAVE_MS = 1000;

const HOUR_MS = 60 * 60_000;

/** The author associations a `collaborators` filter takes. */
const COLLABORATORS: ReadonlySet<string> = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export interface StandingSchedulerOptions {
  readonly store: StandingStore;
  readonly pool: Pick<SlotPool, "freeForStanding" | "leaseForStanding" | "hasSlot">;
  readonly runners: StandingRunners;
  readonly pulls: PullSource;
  /** The runner's books, which standing spend is booked in and refused by too. */
  readonly ledger: SpendLedger;
  /** `RUNNER_STANDING_DAILY_BUDGET_USD`; `undefined` for none. */
  readonly budgetUsd: number | undefined;
  /** Why the runner takes no standing tasks at all, such as a real agent with no standing budget. */
  readonly off?: StandingOff | undefined;
  readonly maxConcurrent: number;
  readonly redactor?: Redactor;
  readonly now?: () => number;
  readonly eventId?: () => string;
  readonly tickMs?: number;
  readonly log?: (line: string) => void;
  readonly debug?: (line: string) => void;
}

/** A run under way. */
interface ActiveRun {
  readonly taskId: string;
  readonly key: string;
  readonly lease: StandingSlotLease;
  /** The scheduler's own say over the run: a removed task stops it. */
  readonly controller: AbortController;
  readonly startedAt: number;
  /** What it wrote on its slot's screen, as plain text, its tail kept. */
  log: string;
  /** What it has booked against its task so far. */
  bookedUsd: number;
  /** Settles once the run has ended and been recorded. */
  done: Promise<void>;
}

/** Why a task may start nothing now, and whether it is a budget that says so in the office. */
interface Block {
  readonly reason: string;
  readonly budget: boolean;
}

function short(text: string, maxBytes: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return fitBytes(line, maxBytes);
}

/** A terminal's output as plain text: its escape sequences gone and its line ends `\n`. */
export function plainText(data: string): string {
  return (
    data
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b./g, "")
      .replace(/\r\n?/g, "\n")
  );
}

/** The end of `text` within `maxBytes` as JSON writes it, from a whole line where it can be. */
export function tailBytes(text: string, maxBytes: number): string {
  if (jsonTextBytes(text) <= maxBytes) {
    return text;
  }
  const characters = Array.from(text);
  const cut = "…\n";
  let used = jsonTextBytes(cut);
  let start = characters.length;
  while (start > 0) {
    const bytes = jsonTextBytes(characters[start - 1] ?? "");
    if (used + bytes > maxBytes) {
      break;
    }
    used += bytes;
    start -= 1;
  }
  const kept = characters.slice(start).join("");
  const line = kept.indexOf("\n");
  return `${cut}${line >= 0 && line < kept.length - 1 ? kept.slice(line + 1) : kept}`;
}

/** What a ledger key's run does. */
function stepOf(key: string): StandingStep {
  if (key.startsWith("fix:")) {
    return "resolve";
  }
  if (key.startsWith("merge:")) {
    return "merge";
  }
  return key.startsWith("pr:") ? "review" : "run";
}

export class StandingScheduler {
  private data: StandingFile;
  private readonly events: RunnerEvent[] = [];
  private readonly runs = new Map<string, ActiveRun>();
  private readonly polling = new Set<string>();
  private readonly now: () => number;
  private readonly eventId: () => string;
  private readonly log: (line: string) => void;
  private readonly debug: (line: string) => void;
  private readonly redactor: Redactor;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastSpendSave = 0;

  public constructor(private readonly options: StandingSchedulerOptions) {
    this.now = options.now ?? Date.now;
    this.eventId = options.eventId ?? (() => `standing-${randomUUID()}`);
    this.log = options.log ?? (() => undefined);
    this.debug = options.debug ?? (() => undefined);
    this.redactor = options.redactor ?? createRedactor([]);
    this.data = options.store.load(this.today());
    this.recover();
  }

  /** Every task as the sync reports it. */
  public report(): StandingTaskReport[] {
    this.rollOver();
    return this.data.tasks.map((task) => this.reportOf(task));
  }

  public off(): StandingOff | undefined {
    return this.options.off;
  }

  /** What all standing tasks have spent today, those since removed too. */
  public spentTodayUsd(): number {
    this.rollOver();
    return this.data.spentTodayUsd;
  }

  public pendingEvents(): readonly RunnerEvent[] {
    return this.events;
  }

  public delivered(ids: ReadonlySet<string>): void {
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const event = this.events[index];
      if (event !== undefined && ids.has(event.id)) {
        this.events.splice(index, 1);
      }
    }
    const unsent = this.data.unsent.filter((record) => !ids.has(record.id));
    if (unsent.length !== this.data.unsent.length) {
      this.data.unsent = unsent;
      this.save();
    }
  }

  /** The runs' records the server has not been given yet, oldest first. */
  public pendingRuns(): readonly StandingRunRecord[] {
    return this.data.unsent;
  }

  /** Starts checking triggers and starting runs, after booking today's standing spend in the runner's ledger. */
  public start(): void {
    if (this.timer !== undefined) {
      return;
    }
    // A restarted runner keeps its day: what standing tasks spent today is still spent.
    this.options.ledger.add(this.spentTodayUsd());
    this.timer = setInterval(() => this.tick(), this.options.tickMs ?? DEFAULT_TICK_MS);
    this.timer.unref();
    this.tick();
  }

  /**
   * Stops checking; a run under way is stopped with its slot by the pool, and
   * left `running` to be tried again. Resolves once every run under way has
   * ended, its agent exited.
   */
  public stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    this.save();
    return Promise.all([...this.runs.values()].map((run) => run.done)).then(() => undefined);
  }

  /** One look at every task: checks due, firings due, retries due, and runs to start. Exposed for the tests. */
  public tick(): void {
    this.rollOver();
    // A task kept in standing.json from before the runner was turned off checks and runs nothing.
    if (this.offReason() !== undefined) {
      return;
    }
    const now = this.now();
    for (const task of [...this.data.tasks]) {
      const agent = task.spec.agent;
      if (agent !== undefined && !this.options.pool.hasSlot(agent)) {
        // The agent hired for it was fired: the role goes with it.
        this.data.tasks = this.data.tasks.filter((candidate) => candidate !== task);
        this.runs.get(task.spec.id)?.controller.abort("removed");
        this.log(`standing task "${task.spec.name}" (${task.spec.id}) removed: its agent, ${agent}, is no longer on this runner`);
        this.save();
        continue;
      }
      if (task.spec.paused) {
        continue;
      }
      this.retryDue(task, now);
      if (task.nextCheckAt !== undefined && now >= task.nextCheckAt) {
        if (task.spec.kind === STANDING_KIND.schedule) {
          this.fire(task, task.nextCheckAt);
        } else {
          void this.poll(task);
        }
      }
    }
    this.pump();
  }

  /** Carries out one command from the server. */
  public handle(command: RunnerStandingCommand): void {
    if (command.kind === RUNNER_COMMAND_KIND.standingSet) {
      this.set(command.spec, command.requestedBy);
      return;
    }
    const task = this.find(command.taskId);
    if (task === undefined) {
      this.log(`${command.kind} for standing task ${command.taskId} ignored: the runner holds no such task`);
      return;
    }
    if (command.kind === RUNNER_COMMAND_KIND.standingReschedule) {
      this.reschedule(task, command.schedule, command.requestedBy);
      return;
    }
    const name = `"${task.spec.name}" (${task.spec.id})`;
    const off = this.offReason();
    if (off !== undefined && (command.kind === RUNNER_COMMAND_KIND.standingResume || command.kind === RUNNER_COMMAND_KIND.standingCheckNow)) {
      this.log(`${command.kind} for standing task ${name} from ${command.requestedBy} refused: ${off}`);
      return;
    }
    switch (command.kind) {
      case RUNNER_COMMAND_KIND.standingPause:
        if (!task.spec.paused) {
          task.spec = { ...task.spec, paused: true };
          this.log(`standing task ${name} paused by ${command.requestedBy}`);
        }
        break;
      case RUNNER_COMMAND_KIND.standingResume:
        if (task.spec.paused) {
          task.spec = { ...task.spec, paused: false };
          task.nextCheckAt = this.firstCheck(task.spec);
          this.log(`standing task ${name} resumed by ${command.requestedBy}`);
        }
        break;
      case RUNNER_COMMAND_KIND.standingRemove: {
        this.data.tasks = this.data.tasks.filter((candidate) => candidate !== task);
        const run = this.runs.get(task.spec.id);
        if (run !== undefined) {
          run.controller.abort("removed");
        }
        this.log(`standing task ${name} removed by ${command.requestedBy}${run === undefined ? "" : "; its run was stopped"}`);
        break;
      }
      case RUNNER_COMMAND_KIND.standingCheckNow:
        if (task.spec.kind === STANDING_KIND.schedule) {
          this.fire(task, this.now());
        } else {
          task.nextCheckAt = this.now();
        }
        this.log(`standing task ${name} checked now by ${command.requestedBy}`);
        break;
    }
    this.save();
    this.tick();
  }

  /** A new schedule for a task, as a new version of its definition. */
  private reschedule(task: StoredTask, schedule: StandingSchedule, requestedBy: string): void {
    const name = `"${task.spec.name}" (${task.spec.id})`;
    const changed = rescheduled(task.spec, schedule);
    const spec = changed === undefined ? undefined : parseStandingTaskSpec(changed);
    if (spec === undefined) {
      const why = "that is not a schedule this task takes";
      this.log(`new schedule for standing task ${name} from ${requestedBy} refused: ${why}`);
      this.emit({ id: this.eventId(), kind: RUNNER_EVENT_KIND.standingRefused, taskId: task.spec.id, name: short(task.spec.name, MAX_STANDING_NAME_BYTES), message: why });
      return;
    }
    task.spec = this.held(spec);
    task.nextCheckAt = task.spec.paused ? undefined : this.firstCheck(task.spec);
    this.log(`standing task ${name} now runs ${this.trigger(task.spec)}, as ${requestedBy} asked`);
    this.save();
    this.tick();
  }

  private set(spec: StandingTaskSpec, requestedBy: string): void {
    const existing = this.find(spec.id);
    const refuse = (why: string): void => {
      this.log(`standing task "${spec.name}" (${spec.id}) from ${requestedBy} refused: ${why}`);
      this.emit({ id: this.eventId(), kind: RUNNER_EVENT_KIND.standingRefused, taskId: spec.id, name: short(spec.name, MAX_STANDING_NAME_BYTES), message: short(why, MAX_WORK_NOTE_LENGTH) });
    };
    const off = this.offReason();
    if (off !== undefined) {
      refuse(off);
      return;
    }
    if (existing !== undefined) {
      if (spec.version <= existing.spec.version) {
        this.debug(`standing task ${spec.id} restated at version ${spec.version}; it already has ${existing.spec.version}`);
        return;
      }
      if (existing.spec.kind !== spec.kind) {
        existing.ledger = {};
        existing.baselined = false;
      }
      existing.spec = this.held(spec);
      existing.nextCheckAt = this.firstCheck(existing.spec);
      this.log(`standing task "${spec.name}" (${spec.id}) updated to version ${spec.version} by ${requestedBy}`);
    } else {
      if (this.data.tasks.length >= MAX_STANDING_TASKS) {
        refuse(`the runner already holds ${MAX_STANDING_TASKS} standing tasks`);
        return;
      }
      if (watchesPullRequests(spec.kind) && this.data.tasks.some((task) => watchesPullRequests(task.spec.kind))) {
        refuse("the runner already watches for new pull requests");
        return;
      }
      if (spec.agent !== undefined && !this.options.pool.hasSlot(spec.agent)) {
        refuse(`its agent, ${spec.agent}, is not on this runner`);
        return;
      }
      const held = this.held(spec);
      this.data.tasks.push({
        spec: held,
        requestedBy,
        baselined: false,
        ledger: {},
        spentTodayUsd: 0,
        handledToday: 0,
        runStarts: [],
        nextCheckAt: this.firstCheck(held),
        checkError: "",
        runError: "",
        recent: [],
        open: [],
      });
      this.log(
        `standing task "${held.name}" (${held.id}) added by ${requestedBy}: ${this.trigger(held)}, ` +
          `${formatUsd(held.caps.perRunUsd)} and ${held.caps.runMinutes} min a run, ${formatUsd(held.caps.dailyUsd)} and ` +
          `${held.caps.maxRunsPerHour} runs an hour a day` +
          (this.options.runners.simulated ? "; simulated runs, nothing is posted or spent for real" : ""),
      );
    }
    this.save();
    this.tick();
  }

  private offReason(): string | undefined {
    return this.options.off === STANDING_OFF.noBudget
      ? "this runner's agents are real, and its operator has not set RUNNER_STANDING_DAILY_BUDGET_USD, so it takes no standing tasks"
      : undefined;
  }

  /** A definition held to what the runner allows: no task may spend more in a day, or a run, than every standing task together may. */
  private held(spec: StandingTaskSpec): StandingTaskSpec {
    const budget = this.options.budgetUsd;
    if (budget === undefined) {
      return spec;
    }
    const caps: StandingCaps = {
      ...spec.caps,
      perRunUsd: Math.min(spec.caps.perRunUsd, budget),
      dailyUsd: Math.min(spec.caps.dailyUsd, budget),
    };
    return { ...spec, caps };
  }

  private firstCheck(spec: StandingTaskSpec): number | undefined {
    if (spec.kind !== STANDING_KIND.schedule) {
      return this.now();
    }
    const schedule = parseCron(spec.cron);
    return schedule === undefined ? undefined : nextFire(schedule, new Date(this.now()))?.getTime();
  }

  private trigger(spec: StandingTaskSpec): string {
    if (spec.kind === STANDING_KIND.schedule) {
      const schedule = parseCron(spec.cron);
      return schedule === undefined ? spec.cron : describeCron(schedule);
    }
    const seconds = Math.max(spec.intervalSeconds, this.options.runners.minPollIntervalMs / 1000);
    return seconds % 60 === 0 ? `every ${seconds / 60} min` : `every ${seconds} s`;
  }

  /** Looks at GitHub's open pull requests for a pull request task, and for the steward at each it reviewed. */
  private async poll(task: StoredTask): Promise<void> {
    const id = task.spec.id;
    if (this.polling.has(id) || task.spec.kind === STANDING_KIND.schedule) {
      return;
    }
    this.polling.add(id);
    const interval = Math.max(task.spec.intervalSeconds * 1000, this.options.runners.minPollIntervalMs);
    // Not again until this look is over and the interval has passed.
    task.nextCheckAt = undefined;
    try {
      const listing = await this.options.pulls(task.etag);
      if (this.find(id) !== task) {
        return;
      }
      if (listing.kind === "listed") {
        task.etag = listing.etag;
        this.evaluate(task, listing.pulls);
      }
      if (task.spec.kind === STANDING_KIND.prSteward) {
        await this.steward(task);
        if (this.find(id) !== task) {
          return;
        }
      }
      if (task.checkError !== "") {
        this.log(`standing task "${task.spec.name}" reads GitHub's pull requests again`);
      }
      task.checkError = "";
    } catch (error) {
      const why = short(this.redactor.redactText(`Could not read pull requests: ${(error as Error).message}`), MAX_STANDING_ERROR_BYTES);
      if (why !== task.checkError) {
        this.log(`standing task "${task.spec.name}": ${why}`);
      }
      task.checkError = why;
    } finally {
      this.polling.delete(id);
      task.lastCheckAt = this.now();
      task.nextCheckAt = task.spec.paused ? undefined : this.now() + interval;
      this.save();
      this.pump();
    }
  }

  /** Brings a task's ledger up to date with the open pull requests. */
  private evaluate(task: StoredTask, pulls: readonly OpenPull[]): void {
    const now = this.now();
    task.open = pulls.map((pull) => pull.number);
    const open = new Set<string>();
    for (const pull of pulls) {
      const key = `pr:${pull.number}`;
      open.add(key);
      const entry = task.ledger[key];
      if (!task.baselined) {
        task.ledger[key] ??= { state: LEDGER_STATE.baseline, attempts: 0, at: now, title: pull.title, headSha: pull.headSha, seenAt: now };
        continue;
      }
      if (entry !== undefined) {
        entry.seenAt = now;
        entry.title = pull.title;
        entry.headSha = pull.headSha;
        // A draft waits until it is ready for review.
        if (!(entry.state === LEDGER_STATE.skipped && entry.reason === "draft" && !pull.draft)) {
          continue;
        }
      }
      task.ledger[key] = this.arrival(task, pull, now);
    }
    if (!task.baselined) {
      task.baselined = true;
      this.log(`standing task "${task.spec.name}" leaves the ${pulls.length} open pull requests there now alone; it reviews new ones`);
    }
    for (const [key, entry] of Object.entries(task.ledger)) {
      if (open.has(`pr:${prOf(key) ?? ""}`)) {
        continue;
      }
      if (entry.state === LEDGER_STATE.queued || (entry.state === LEDGER_STATE.failed && entry.retryAt !== undefined)) {
        // Closed before a review, a resolve or a merge could be had: nothing to do any more.
        this.skip(entry, "closed");
      }
      if ((entry.seenAt ?? entry.at) < now - PRUNE_AFTER_MS && entry.state !== LEDGER_STATE.running) {
        delete task.ledger[key];
      }
    }
    this.trimLedger(task, MAX_LEDGER_ENTRIES);
  }

  /** A pull request seen for the first time since the task's first look. */
  private arrival(task: StoredTask, pull: OpenPull, now: number): LedgerEntry {
    const base = { attempts: 0, at: now, title: pull.title, headSha: pull.headSha, seenAt: now };
    if (pull.draft) {
      return { ...base, state: LEDGER_STATE.skipped, reason: "draft" };
    }
    const collaboratorsOnly = task.spec.kind === STANDING_KIND.prSteward || (task.spec.kind === STANDING_KIND.prReview && task.spec.authors === "collaborators");
    if (collaboratorsOnly && !pull.ownAgent && !COLLABORATORS.has(pull.association)) {
      const who = pull.author === "" ? "an outside contributor" : `${pull.author}, an outside contributor`;
      this.record(task, STANDING_OUTCOME.skipped, pull.number);
      this.emitRun(task, undefined, { number: pull.number, title: pull.title }, STANDING_OUTCOME.skipped, 0, `It is by ${who}, so it was not reviewed.`, false);
      this.log(`standing task "${task.spec.name}" skips PR #${pull.number}: it is by ${who}`);
      return { ...base, state: LEDGER_STATE.skipped, reason: "outside" };
    }
    this.log(`standing task "${task.spec.name}" queues PR #${pull.number} for review`);
    return { ...base, state: LEDGER_STATE.queued };
  }

  /**
   * The steward's look at each pull request it has reviewed that is still
   * open: what next for each, from a fresh look at GitHub. A resolve or a
   * merge is queued once for a head commit, and a reason it is not merged
   * said once; everything else waits for the next check.
   */
  private async steward(task: StoredTask): Promise<void> {
    const inspect = this.options.runners.inspect;
    if (inspect === undefined || !task.baselined) {
      return;
    }
    for (const number of task.open) {
      const review = task.ledger[`pr:${number}`];
      if (review?.state !== LEDGER_STATE.done) {
        continue;
      }
      const state = await inspect(number);
      if (this.find(task.spec.id) !== task || task.spec.paused) {
        return;
      }
      if (!HEAD_SHA.test(state.headSha)) {
        continue;
      }
      const step = stewardStep(state);
      const at = `${number}@${state.headSha}`;
      const now = this.now();
      const base = { attempts: 0, at: now, title: review.title, headSha: state.headSha, seenAt: now };
      if (step.kind === "merge" || step.kind === "resolve") {
        const key = `${step.kind === "merge" ? "merge" : "fix"}:${at}`;
        if (task.ledger[key] === undefined) {
          task.ledger[key] = { ...base, state: LEDGER_STATE.queued };
          this.log(`standing task "${task.spec.name}" queues PR #${number} at ${state.headSha.slice(0, 7)} to ${step.kind === "merge" ? "merge: every required check is green" : "merge its base in and resolve its conflicts"}`);
        }
      } else if (step.kind === "hold" && task.ledger[`hold:${at}`] === undefined) {
        task.ledger[`hold:${at}`] = { ...base, state: LEDGER_STATE.skipped, reason: "held" };
        const pr = { number, title: fitBytes(review.title ?? "", MAX_TITLE_LENGTH) };
        this.record(task, STANDING_OUTCOME.skipped, number);
        this.emitRun(task, undefined, pr, STANDING_OUTCOME.skipped, 0, `It is not merged yet: ${step.why}.`, false);
        this.log(`standing task "${task.spec.name}" does not merge PR #${number} at ${state.headSha.slice(0, 7)}: ${step.why}`);
      }
    }
    this.trimLedger(task, MAX_LEDGER_ENTRIES);
  }

  /** One firing of a schedule: queued, or missed when the task could not start it. */
  private fire(task: StoredTask, at: number): void {
    if (task.spec.kind !== STANDING_KIND.schedule) {
      return;
    }
    const schedule = parseCron(task.spec.cron);
    task.lastCheckAt = this.now();
    task.nextCheckAt = schedule === undefined ? undefined : nextFire(schedule, new Date(Math.max(at, this.now())))?.getTime();
    for (const entry of Object.values(task.ledger)) {
      if (entry.state === LEDGER_STATE.queued || (entry.state === LEDGER_STATE.failed && entry.retryAt !== undefined)) {
        // Only the newest firing matters: an older one still waiting is superseded.
        this.skip(entry, "superseded");
      }
    }
    const block = this.block(task);
    const key = `at:${at}`;
    if (block !== undefined) {
      task.ledger[key] = { state: LEDGER_STATE.skipped, attempts: 0, at, reason: "missed" };
      this.record(task, STANDING_OUTCOME.skipped, undefined);
      this.log(`standing task "${task.spec.name}" missed a firing: ${block.reason}`);
    } else {
      task.ledger[key] = { state: LEDGER_STATE.queued, attempts: 0, at };
      this.debug(`standing task "${task.spec.name}" fired for ${new Date(at).toISOString()}`);
    }
    this.trimLedger(task, MAX_SCHEDULE_ENTRIES);
    this.save();
  }

  private retryDue(task: StoredTask, now: number): void {
    for (const entry of Object.values(task.ledger)) {
      if (entry.state === LEDGER_STATE.failed && entry.retryAt !== undefined && now >= entry.retryAt) {
        entry.state = LEDGER_STATE.queued;
        entry.retryAt = undefined;
      }
    }
  }

  /** Starts what can start: the oldest queued event of each task, while slots and caps allow. */
  private pump(): void {
    const candidates = this.data.tasks
      .filter((task) => !task.spec.paused && !this.runs.has(task.spec.id))
      .map((task) => ({ task, next: this.nextQueued(task) }))
      .filter((candidate): candidate is { task: StoredTask; next: [string, LedgerEntry] } => candidate.next !== undefined)
      .sort((a, b) => a.next[1].at - b.next[1].at);
    // A slot an agent was hired into is its own task's alone.
    const owned = new Set(this.data.tasks.flatMap((task) => (task.spec.agent === undefined ? [] : [task.spec.agent])));
    for (const { task, next } of candidates) {
      if (this.runs.size >= this.options.maxConcurrent) {
        return;
      }
      const block = this.block(task);
      if (block !== undefined) {
        if (block.budget && task.refusedDay !== this.today()) {
          task.refusedDay = this.today();
          const [key, entry] = next;
          this.record(task, STANDING_OUTCOME.refusedBudget, prOf(key));
          this.emitRun(task, undefined, this.prRef(key, entry), STANDING_OUTCOME.refusedBudget, 0, block.reason, false);
          this.log(`standing task "${task.spec.name}" starts nothing: ${block.reason}`);
          this.save();
        }
        continue;
      }
      const free = this.options.pool.freeForStanding();
      const own = task.spec.agent;
      const slotId = own === undefined ? free.find((id) => !owned.has(id)) : free.includes(own) ? own : undefined;
      if (slotId === undefined) {
        continue;
      }
      this.begin(task, next[0], next[1], slotId);
    }
  }

  private nextQueued(task: StoredTask): [string, LedgerEntry] | undefined {
    let oldest: [string, LedgerEntry] | undefined;
    for (const pair of Object.entries(task.ledger)) {
      if (pair[1].state === LEDGER_STATE.queued && (oldest === undefined || pair[1].at < oldest[1].at)) {
        oldest = pair;
      }
    }
    return oldest;
  }

  /** Why a task may start nothing now, or `undefined` while every cap has room. */
  private block(task: StoredTask): Block | undefined {
    const { caps } = task.spec;
    if (task.spentTodayUsd >= caps.dailyUsd) {
      return { reason: `it has spent its ${formatUsd(caps.dailyUsd)} for today`, budget: false };
    }
    if (task.hourCapDay === this.today()) {
      return { reason: `it reached ${caps.maxRunsPerHour} runs within an hour today, so it starts nothing more until tomorrow`, budget: false };
    }
    const budget = this.options.budgetUsd;
    if (budget !== undefined && this.data.spentTodayUsd >= budget) {
      return {
        reason: `the runner's standing budget of ${formatUsd(budget)} a day is spent (${formatUsd(this.data.spentTodayUsd)} today), so standing tasks start nothing until midnight on its machine`,
        budget: true,
      };
    }
    const runner = this.options.ledger.refusal();
    return runner === undefined ? undefined : { reason: runner, budget: true };
  }

  private begin(task: StoredTask, key: string, entry: LedgerEntry, slotId: string): void {
    const now = this.now();
    const pr = this.prRef(key, entry);
    const step = stepOf(key);
    const activity = {
      review: `Reviewing PR #${pr?.number ?? ""}`,
      resolve: `Resolving PR #${pr?.number ?? ""}'s conflicts`,
      merge: `Merging PR #${pr?.number ?? ""}`,
      run: `Running “${task.spec.name}”`,
    }[step];
    const lease = this.options.pool.leaseForStanding(slotId, { taskId: task.spec.id, pr: pr?.number }, activity);
    if (lease === undefined) {
      return;
    }
    entry.state = LEDGER_STATE.running;
    entry.attempts += 1;
    task.runStarts = [...task.runStarts.filter((at) => at > now - HOUR_MS), now];
    if (task.runStarts.length >= task.spec.caps.maxRunsPerHour) {
      task.hourCapDay = this.today();
    }
    // Saved before the agent starts, so a restart knows this run was cut short.
    this.save();
    const run: ActiveRun = {
      taskId: task.spec.id,
      key,
      lease,
      controller: new AbortController(),
      startedAt: now,
      log: "",
      bookedUsd: 0,
      done: Promise.resolve(),
    };
    this.runs.set(task.spec.id, run);
    this.log(
      `${lease.slotName} starts standing task "${task.spec.name}"${pr === undefined ? "" : ` to ${step} PR #${pr.number}`}` +
        ` (attempt ${entry.attempts} of ${MAX_ATTEMPTS})` +
        (this.options.runners.simulated ? ": a simulated run, nothing is posted" : ""),
    );
    const job = {
      spec: task.spec,
      step,
      requestedBy: task.requestedBy,
      lease: this.booking(task, run),
      signal: AbortSignal.any([lease.signal, run.controller.signal]),
      pr: pr === undefined ? undefined : { ...pr, headSha: entry.headSha ?? "" },
      firedAt: pr === undefined ? entry.at : undefined,
    };
    const { runners } = this.options;
    const work = { review: () => runners.review(job), resolve: () => runners.resolve(job), merge: () => runners.merge(job), run: () => runners.schedule(job) }[step]();
    run.done = work
      .catch((error: unknown): StandingRunResult => ({ outcome: "failed", costUsd: run.bookedUsd, message: `The run broke: ${(error as Error).message}` }))
      .then((result) => this.finish(task, run, entry, result));
  }

  /** The lease as a run sees it, its spend booked against its task as it is said and its screen kept as its log. */
  private booking(task: StoredTask, run: ActiveRun): StandingSlotLease {
    return {
      ...run.lease,
      output: (data) => {
        run.lease.output(data);
        // Twice the record's budget, so the tail is cut once, from a whole line, when the run is recorded.
        run.log = tailBytes(run.log + plainText(data), MAX_STANDING_LOG_BYTES * 2);
      },
      spent: (totalUsd) => {
        run.lease.spent(totalUsd);
        this.book(task, run, totalUsd);
      },
    };
  }

  private book(task: StoredTask, run: ActiveRun, totalUsd: number): void {
    if (!Number.isFinite(totalUsd) || totalUsd <= run.bookedUsd) {
      return;
    }
    this.rollOver();
    const delta = totalUsd - run.bookedUsd;
    run.bookedUsd = totalUsd;
    task.spentTodayUsd += delta;
    this.data.spentTodayUsd += delta;
    if (this.now() - this.lastSpendSave >= SPEND_SAVE_MS) {
      this.lastSpendSave = this.now();
      this.save();
    }
  }

  private finish(task: StoredTask, run: ActiveRun, entry: LedgerEntry, result: StandingRunResult): void {
    this.runs.delete(task.spec.id);
    run.lease.release();
    this.book(task, run, result.costUsd);
    const cost = run.bookedUsd;
    const ended = run.lease.signal.aborted ? (run.lease.signal.reason as unknown) : run.controller.signal.aborted ? "removed" : undefined;
    const pr = this.prRef(run.key, entry);
    const on = `${run.lease.slotName}'s run of "${task.spec.name}"${pr === undefined ? "" : ` on PR #${pr.number}`}`;
    if (ended === "removed" || this.find(task.spec.id) !== task) {
      this.log(`${on} stopped: the task was removed (${formatUsd(cost)} spent)`);
      this.save();
      this.pump();
      return;
    }
    if (ended === STANDING_SLOT_END.shutdown) {
      // Left `running`: the next start tries it again.
      this.log(`${on} stopped as the runner shut down (${formatUsd(cost)} spent)`);
      this.save();
      return;
    }
    const now = this.now();
    if (ended === STANDING_SLOT_END.preempted) {
      entry.state = LEDGER_STATE.queued;
      entry.attempts = Math.max(entry.attempts - 1, 0);
      task.runStarts = task.runStarts.slice(0, -1);
      if (task.runStarts.length < task.spec.caps.maxRunsPerHour && task.hourCapDay === this.today()) {
        task.hourCapDay = undefined;
      }
      this.record(task, STANDING_OUTCOME.preempted, pr?.number);
      this.emitRun(task, run.lease.slotId, pr, STANDING_OUTCOME.preempted, cost, "Issue work took the slot; it runs again on a free one.", false, undefined, run);
      this.log(`${on} gave way to issue work; queued again (${formatUsd(cost)} spent)`);
    } else if (result.outcome === "failed") {
      const final = entry.attempts >= MAX_ATTEMPTS;
      entry.state = LEDGER_STATE.failed;
      entry.retryAt = final ? undefined : now + (RETRY_BACKOFF_MS[entry.attempts - 1] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1] ?? 60_000);
      task.runError = short(this.redactor.redactText(result.message), MAX_STANDING_ERROR_BYTES);
      task.handledToday += 1;
      this.record(task, STANDING_OUTCOME.failed, pr?.number);
      this.emitRun(task, run.lease.slotId, pr, STANDING_OUTCOME.failed, cost, result.message, final, undefined, run);
      this.log(`${on} failed${final ? " for the last time" : "; it is tried again later"}: ${this.redactor.redactText(result.message)} (${formatUsd(cost)} spent)`);
    } else {
      entry.state = result.outcome === "skipped" ? LEDGER_STATE.skipped : LEDGER_STATE.done;
      entry.commentId = result.commentId;
      task.runError = "";
      task.handledToday += 1;
      const outcome = toOutcome(result.outcome);
      this.record(task, outcome, pr?.number);
      this.emitRun(task, run.lease.slotId, pr, outcome, cost, result.message, false, result.commentId, run);
      this.log(`${on}: ${outcome} (${formatUsd(cost)} spent)`);
    }
    this.save();
    this.pump();
  }

  private prRef(key: string, entry: LedgerEntry): { readonly number: number; readonly title: string } | undefined {
    const number = prOf(key);
    return number === undefined ? undefined : { number, title: fitBytes(entry.title ?? "", MAX_TITLE_LENGTH) };
  }

  private skip(entry: LedgerEntry, reason: SkipReason): void {
    entry.state = LEDGER_STATE.skipped;
    entry.reason = reason;
    entry.retryAt = undefined;
  }

  private record(task: StoredTask, outcome: StandingOutcome, pr: number | undefined): void {
    task.recent = [{ at: this.now(), outcome, pr }, ...task.recent].slice(0, MAX_STANDING_RECENT);
  }

  private emitRun(
    task: StoredTask,
    slotId: string | undefined,
    pr: { readonly number: number; readonly title: string } | undefined,
    outcome: StandingOutcome,
    costUsd: number,
    message: string,
    final: boolean,
    commentId?: number,
    run?: ActiveRun,
  ): void {
    const said = pr === undefined ? undefined : { number: pr.number, title: fitBytes(this.redactor.redactText(pr.title), MAX_TITLE_LENGTH) };
    const text = this.redactor.redactText(message.trim());
    this.emit({
      id: this.eventId(),
      kind: RUNNER_EVENT_KIND.standingRun,
      taskId: task.spec.id,
      slotId,
      pr: said,
      outcome,
      commentId,
      costUsd,
      // A scheduled run's result keeps its line breaks, as the AI Manager posts it.
      message: fitBytes(text, MAX_STANDING_MESSAGE_BYTES),
      final,
    });
    const now = this.now();
    // The wall board's record of it, a separate id so its delivery is its own.
    this.data.unsent = [
      ...this.data.unsent,
      {
        id: this.eventId(),
        taskId: task.spec.id,
        startedAt: run?.startedAt ?? now,
        endedAt: now,
        outcome,
        pr: said,
        agent: run === undefined ? "" : fitBytes(run.lease.slotName, MAX_STANDING_NAME_BYTES),
        costUsd,
        summary: short(summaryOf(outcome, said, text, task.spec.name), MAX_STANDING_SUMMARY_BYTES),
        result: fitBytes(text, MAX_STANDING_RESULT_BYTES),
        log: run === undefined ? "" : tailBytes(this.redactor.redactText(run.log).trimEnd(), MAX_STANDING_LOG_BYTES),
        commentId,
      },
    ].slice(-MAX_UNSENT_RUNS);
  }

  private emit(event: RunnerEvent): void {
    this.events.push(event);
    if (this.events.length > MAX_PENDING_EVENTS) {
      this.events.shift();
    }
  }

  private reportOf(task: StoredTask): StandingTaskReport {
    const queued = Object.values(task.ledger).filter((entry) => entry.state === LEDGER_STATE.queued).length;
    const block = this.block(task);
    const off = this.offReason();
    return {
      id: task.spec.id,
      kind: task.spec.kind,
      name: fitBytes(task.spec.name, MAX_STANDING_NAME_BYTES),
      status: off === undefined ? this.statusOf(task, queued, block) : STANDING_STATUS.error,
      trigger: fitBytes(this.trigger(task.spec), MAX_STANDING_TRIGGER_BYTES),
      schedule: task.spec.kind === STANDING_KIND.schedule ? { cron: task.spec.cron } : { intervalSeconds: task.spec.intervalSeconds },
      agent: task.spec.agent,
      lastCheckAt: task.lastCheckAt,
      nextCheckAt: task.spec.paused || block !== undefined || off !== undefined ? undefined : task.nextCheckAt,
      queued,
      handledToday: task.handledToday,
      spentTodayUsd: task.spentTodayUsd,
      dailyUsd: task.spec.caps.dailyUsd,
      lastError: fitBytes(off === undefined ? task.checkError || task.runError : "Off: RUNNER_STANDING_DAILY_BUDGET_USD is not set", MAX_STANDING_ERROR_BYTES),
      recent: task.recent,
    };
  }

  private statusOf(task: StoredTask, queued: number, block: Block | undefined): StandingStatus {
    if (task.spec.paused) {
      return STANDING_STATUS.paused;
    }
    if (this.runs.has(task.spec.id)) {
      return STANDING_STATUS.running;
    }
    if (block !== undefined) {
      return STANDING_STATUS.overBudget;
    }
    if (queued > 0) {
      return STANDING_STATUS.waitingSlot;
    }
    return task.checkError !== "" || task.runError !== "" ? STANDING_STATUS.error : STANDING_STATUS.active;
  }

  private trimLedger(task: StoredTask, max: number): void {
    const entries = Object.entries(task.ledger);
    if (entries.length <= max) {
      return;
    }
    const settled = entries
      .filter(([, entry]) => entry.state !== LEDGER_STATE.queued && entry.state !== LEDGER_STATE.running)
      .sort((a, b) => a[1].at - b[1].at);
    for (const [key] of settled.slice(0, entries.length - max)) {
      delete task.ledger[key];
    }
  }

  /** At boot: a run the last runner left `running` was cut short, and counts as a failed attempt. */
  private recover(): void {
    const now = this.now();
    for (const task of this.data.tasks) {
      for (const [key, entry] of Object.entries(task.ledger)) {
        if (entry.state !== LEDGER_STATE.running) {
          continue;
        }
        entry.state = LEDGER_STATE.failed;
        entry.retryAt = entry.attempts >= MAX_ATTEMPTS ? undefined : now;
        this.log(`standing task "${task.spec.name}"'s run for ${key} was cut short by a restart; ${entry.retryAt === undefined ? "it has had its attempts" : "it is tried again"}`);
      }
      if (task.spec.kind === STANDING_KIND.schedule && !task.spec.paused) {
        // A firing missed while the runner was down is not caught up.
        task.nextCheckAt = this.firstCheck(task.spec);
      }
      if (task.spec.kind !== STANDING_KIND.schedule && !task.spec.paused) {
        task.nextCheckAt = now;
      }
    }
    this.rollOver();
  }

  /** A new day starts every task's day figures, and the standing total, at nothing. */
  private rollOver(): void {
    const today = this.today();
    if (this.data.day === today) {
      return;
    }
    this.data.day = today;
    this.data.spentTodayUsd = 0;
    for (const task of this.data.tasks) {
      task.spentTodayUsd = 0;
      task.handledToday = 0;
    }
    this.save();
  }

  private today(): string {
    return localDay(new Date(this.now()));
  }

  private find(taskId: string): StoredTask | undefined {
    return this.data.tasks.find((task) => task.spec.id === taskId);
  }

  private save(): void {
    this.options.store.save(this.data);
  }
}

/** A head commit as a ledger key names it. */
const HEAD_SHA = /^[0-9a-f]{7,64}$/;

function prOf(key: string): number | undefined {
  const match = /^(?:pr|fix|merge|hold):(\d+)/.exec(key);
  return match === null ? undefined : Number(match[1]);
}

/** A record's one line: what came of it, in the board's words. */
function summaryOf(outcome: StandingOutcome, pr: { readonly number: number; readonly title: string } | undefined, message: string, taskName: string): string {
  const on = pr === undefined ? "" : ` PR #${pr.number}${pr.title === "" ? "" : ` “${pr.title}”`}`;
  const first = message.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";
  switch (outcome) {
    case STANDING_OUTCOME.reviewed:
      return `Reviewed${on}`;
    case STANDING_OUTCOME.resolved:
      return `Merged the base into${on}, its conflicts resolved, and pushed`;
    case STANDING_OUTCOME.merged:
      return `Merged${on}`;
    case STANDING_OUTCOME.completed:
      return first === "" ? `Ran “${taskName}”` : first;
    case STANDING_OUTCOME.simulated:
      return `Simulated run${on === "" ? ` of “${taskName}”` : ` on${on}`}: nothing was posted or done`;
    default:
      return `${STANDING_OUTCOME_TEXT[outcome].charAt(0).toUpperCase()}${STANDING_OUTCOME_TEXT[outcome].slice(1)}${on}${first === "" ? "" : `: ${first}`}`;
  }
}

function toOutcome(outcome: StandingRunResult["outcome"]): StandingOutcome {
  switch (outcome) {
    case "reviewed":
      return STANDING_OUTCOME.reviewed;
    case "resolved":
      return STANDING_OUTCOME.resolved;
    case "merged":
      return STANDING_OUTCOME.merged;
    case "completed":
      return STANDING_OUTCOME.completed;
    case "simulated":
      return STANDING_OUTCOME.simulated;
    case "skipped":
      return STANDING_OUTCOME.skipped;
    case "failed":
      return STANDING_OUTCOME.failed;
  }
}
