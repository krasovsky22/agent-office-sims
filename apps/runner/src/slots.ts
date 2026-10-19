/**
 * The runner's slots: a fixed set of places an agent can work, what each is
 * doing, and the events their work produces.
 *
 * A slot turns a server's command into an agent's run and an agent's reports
 * into the slot's status and the runner's events, and stops a run that has
 * gone on past the task timeout. Events wait here until a sync carrying them
 * is answered, so a lost sync loses none of them.
 *
 * Each task works in a directory of its own, a git worktree, opened before its
 * agent starts and closed once its work ends; see `./slotWorktrees.ts`.
 *
 * A task is GitHub's issue, and handing it in is a pull request. Before an
 * agent starts, the issue is checked on GitHub for the restriction label. Once
 * the agent opens its pull request the work is handed in, but the slot keeps
 * the task, the agent waiting at its prompt, so the server can send it back
 * for rework with a prompt; the server stops it once the work is done. A turn
 * that ends with no pull request has the slot look for one itself, and say it
 * needs a person when there is none; see `./github.ts`.
 *
 * The task timeout measures the agent's own work. It is held while the agent
 * waits on a person, for as long as the wait lasts, and stops for good once
 * the work is handed in: neither is the agent taking too long.
 *
 * Everything an agent says is cut to the contract's byte budgets here, before
 * it is queued: the server refuses a whole sync for one string too long, and
 * one chatty agent must not stall every slot's report. It is masked first
 * too, as its screen is (`./redact.ts`), since it goes to every client.
 *
 * Each slot also has a terminal screen, `./terminal.ts`, which shows what its
 * agent prints. A new run starts on a cleared screen, and the last run's
 * screen stays up until then.
 *
 * What each task's agent spends is booked in the runner's ledger
 * (`./budget.ts`), and a start that arrives once the day's budget is spent is
 * refused, as a failed start that says why and is marked as the budget's, so
 * the office can explain it.
 * A prompt the CEO typed in the office is given to the agent only while it
 * waits at its prompt: its turn is done, or it ended one with nothing handed
 * in, or it waits on a person and a prompt is its answer, as the mock's wait
 * is. In the middle of a turn, at a real agent's permission or question, or
 * with no task to be at, it is refused instead, never queued behind what the
 * agent is doing, and the slot reports which, by the command's id, until a
 * sync carrying the report is answered. A key the CEO pressed on the choice
 * screen the agent waits on (a permission, a setup or trust screen) is
 * pressed only while it waits on a person, and is reported the same way.
 *
 * While a standup is on in the office (the server says so on every sync,
 * {@link SlotPool.setStandup}), the agents pause at a safe point: an agent
 * that can pause, as the mock can, stops before its next step, and one that
 * cannot, a real agent, finishes the turn it is in and is given no new one by
 * the slot. The task timeout is held throughout, and nothing in progress is
 * stopped or lost. A direction the CEO gave at the standup is typed at once if
 * the agent waits at its prompt; otherwise the slot keeps it, reports it
 * `queued`, and types it the next time the agent is at its prompt with the
 * standup over, reporting it `delivered`, or `unavailable` if the work ends
 * first.
 *
 * Each slot's agent has a profile, a name, title and description
 * (`@sim/shared`'s `agentProfile.ts`): its default until the CEO edits it
 * from the office, kept in `./profiles.ts` once edited, and reported on every
 * sync. The title and description are its agent's system prompt, given as each
 * session or standing run starts, so an edit applies from the next one, never
 * to the session the agent is in.
 */

import { randomUUID } from "node:crypto";

import {
  AGENT_KEY_LABEL,
  type AgentProfile,
  MAX_NAME_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_WORK_NOTE_LENGTH,
  RUNNER_COMMAND_KIND,
  RUNNER_EVENT_KIND,
  RUNNER_PROMPT_OUTCOME,
  RUNNER_REFUSAL,
  RUNNER_SLOT_STATUS,
  type RunnerSlotCommand,
  defaultAgentProfile,
  fitJsonBytes,
  type RunnerSlotStanding,
  type RunnerWorkEventKind,
  type RunnerPromptOutcome,
  type RunnerPromptOutcomeKind,
  type RunnerPullRequest,
  type RunnerRefusal,
  type RunnerSlotReport,
  type RunnerSlotStatus,
  type RunnerSpendReport,
  type RunnerWorkEvent,
  formatUsd,
} from "@sim/shared";

import { systemPrompt } from "./agents/prompt.js";
import type { Agent, AgentReporter, AgentRun } from "./agents/types.js";
import { SpendLedger } from "./budget.js";
import { NO_GITHUB, type TaskGithub } from "./github.js";
import type { AgentProfiles } from "./profiles.js";
import { type Redactor, createRedactor } from "./redact.js";
import { ScreenMirror } from "./terminal.js";

/**
 * Events held while the server cannot be reached. Far more than a few slots
 * produce in any outage worth riding out; past it the oldest go, so a runner
 * cut off for days holds what is newest rather than growing without end.
 */
const MAX_PENDING_EVENTS = 256;

/** A slot's activity once its agent's turn has ended: `idle`, still holding the task. */
export const TURN_DONE = "Turn done";

/** Why a slot whose agent's turn ended with nothing handed in needs a person. */
export const NO_PULL_REQUEST = "Finished without a pull request";

/** Where a slot's tasks work. */
export interface SlotWorkspaces {
  /** A working directory for the task, ready to work in; rejects with why not. */
  open(slotId: string, issueNumber: number): Promise<string>;
  /** The task is over, whether or not its directory was ever opened. Never rejects. */
  close(slotId: string, issueNumber: number): Promise<void>;
}

type StartCommand = Extract<RunnerSlotCommand, { kind: typeof RUNNER_COMMAND_KIND.start }>;
type PromptCommand = Extract<RunnerSlotCommand, { kind: typeof RUNNER_COMMAND_KIND.prompt }>;
type KeyCommand = Extract<RunnerSlotCommand, { kind: typeof RUNNER_COMMAND_KIND.key }>;
type ProfileCommand = Extract<RunnerSlotCommand, { kind: typeof RUNNER_COMMAND_KIND.profile }>;

/** Why a standing run gave its slot up before it finished. */
export const STANDING_SLOT_END = {
  /** An issue's start arrived for the slot: issue work always comes first. */
  preempted: "preempted",
  /** The runner is shutting down. */
  shutdown: "shutdown",
} as const;

export type StandingSlotEnd = (typeof STANDING_SLOT_END)[keyof typeof STANDING_SLOT_END];

/**
 * What a standing task's run, `./standing/`, has of the slot it runs on: its
 * screen, its activity line and the runner's books. Its `signal` aborts, with
 * a {@link StandingSlotEnd} as the reason, when the slot is taken back.
 */
export interface StandingSlotLease {
  readonly slotId: string;
  /** The slot's agent's name, `Maya`, which a posted review and the AI Manager's line name. */
  readonly slotName: string;
  /** Its agent's system prompt, from its profile as the run starts. */
  readonly systemPrompt: string;
  readonly signal: AbortSignal;
  /** Written to the slot's screen. */
  output(data: string): void;
  /** One line of what it is doing now; masked and cut to the contract's budget. */
  activity(text: string): void;
  /** What the run has cost so far, all of it rather than since last said; booked in the runner's ledger. */
  spent(totalUsd: number): void;
  /** The run is over: the slot is free. Idempotent. */
  release(): void;
}

interface StandingOnSlot {
  readonly report: RunnerSlotStanding;
  readonly controller: AbortController;
  spentUsd: number;
}

export interface SlotPoolOptions {
  readonly count: number;
  readonly agent: Agent;
  /** The runner's id, which picks its agents' default names; `runner` by default. */
  readonly runnerId?: string;
  /** Where the CEO's edits to the agents' profiles are kept; every agent keeps its default without it. */
  readonly profiles?: AgentProfiles;
  readonly workspaces: SlotWorkspaces;
  readonly taskTimeoutMs: number;
  /** The issue's label check and the task's pull request; none asked of GitHub by default. */
  readonly github?: TaskGithub;
  /** Masks the runner's secrets in what its agents say; none by default. */
  readonly redactor?: Redactor;
  /** What the agents spend is booked in, and what refuses a start once the day's budget is spent; no budget by default. */
  readonly ledger?: SpendLedger;
  /** Event ids. Injected so a test can name the events it expects. */
  readonly eventId?: () => string;
  readonly log?: (line: string) => void;
  /** Every step an agent reports, too noisy for `log`; dropped by default. */
  readonly debug?: (line: string) => void;
}

interface Slot {
  readonly id: string;
  /** Its agent's name, title and description, as the sync reports them. */
  profile: AgentProfile;
  status: RunnerSlotStatus;
  issueNumber: number | undefined;
  activity: string;
  pr: RunnerPullRequest | undefined;
  run: ActiveRun | undefined;
  /** A standing task's run, which holds the slot instead of an issue until an issue's start takes it back. */
  standing: StandingOnSlot | undefined;
  readonly screen: ScreenMirror;
  /** Standup directions kept for when its agent is next at its prompt, oldest first. */
  readonly kept: PromptCommand[];
}

interface ActiveRun {
  readonly issueNumber: number;
  readonly task: StartCommand;
  agentRun: AgentRun;
  /** Runs while the agent works, and not while it waits on a person or its handed-in work waits on review. */
  timeout: ReturnType<typeof setTimeout> | undefined;
  /** When the running timeout fires, epoch ms. */
  deadline: number;
  /** What was left of the timeout when a wait on a person held it; `undefined` while it is not held. */
  heldMs: number | undefined;
  /** Cleared the moment the work ends, so nothing the agent says afterwards lands. */
  live: boolean;
  /** Whether its `started` event has been queued. */
  started: boolean;
  /** Its worktree, once open. */
  workdir: string | undefined;
  /** It handed its work in since it was last given any. */
  handedIn: boolean;
  /** The slot is looking for its pull request after a turn. */
  checking: boolean;
  /** A turn ended with nothing handed in and the slot said so; until it works again. */
  missing: boolean;
  /** What its agent has said its work cost, in US dollars. */
  spentUsd: number;
}

/** Cuts a string to fit a byte budget, whole characters at a time, as the contract measures it. */
export function fitBytes(value: string, maxBytes: number): string {
  return fitJsonBytes(value, maxBytes);
}

export class SlotPool {
  private readonly slots: Slot[];
  private readonly events: RunnerWorkEvent[] = [];
  private readonly promptOutcomes: RunnerPromptOutcome[] = [];
  private readonly eventId: () => string;
  private readonly log: (line: string) => void;
  private readonly debug: (line: string) => void;
  private readonly redactor: Redactor;
  private readonly github: TaskGithub;
  private readonly ledger: SpendLedger;
  /** A standup is on in the office, as the server last said. */
  private standup = false;

  public constructor(private readonly options: SlotPoolOptions) {
    this.redactor = options.redactor ?? createRedactor([]);
    this.ledger = options.ledger ?? new SpendLedger({ budgetUsd: undefined });
    this.github = options.github ?? NO_GITHUB;
    this.eventId = options.eventId ?? (() => `event-${randomUUID()}`);
    this.log = options.log ?? (() => undefined);
    this.debug = options.debug ?? (() => undefined);
    const now = Date.now();
    const kept = options.profiles?.load() ?? new Map<string, AgentProfile>();
    this.slots = Array.from({ length: options.count }, (_, index) => {
      const id = `slot-${index + 1}`;
      const profile = kept.get(id) ?? defaultAgentProfile(options.runnerId ?? "runner", index);
      const screen = new ScreenMirror(now);
      screen.write(`\u001b[2m${profile.name} is waiting for work.\u001b[0m\r\n`);
      return {
        id,
        profile: { ...profile, name: fitBytes(profile.name, MAX_NAME_LENGTH) },
        status: RUNNER_SLOT_STATUS.idle,
        issueNumber: undefined,
        activity: "",
        pr: undefined,
        run: undefined,
        standing: undefined,
        screen,
        kept: [],
      };
    });
  }

  /** Each slot's id and terminal screen. */
  public screens(): Array<readonly [string, ScreenMirror]> {
    return this.slots.map((slot) => [slot.id, slot.screen] as const);
  }

  /** Every slot as the sync reports it. */
  public report(): RunnerSlotReport[] {
    return this.slots.map((slot) => ({
      id: slot.id,
      name: slot.profile.name,
      title: slot.profile.title,
      description: slot.profile.description,
      status: slot.status,
      issueNumber: slot.issueNumber,
      activity: slot.activity,
      pr: slot.pr,
      ...(slot.standing === undefined ? {} : { standing: slot.standing.report }),
    }));
  }

  /** The slots free for a standing run: holding no run of any kind. */
  public freeForStanding(): readonly string[] {
    return this.slots.filter((slot) => slot.run === undefined && slot.standing === undefined).map((slot) => slot.id);
  }

  /**
   * Hands a free slot to a standing task's run, which shows as working on
   * its screen and activity until it releases the slot. An issue's start for
   * the slot takes it back at once, aborting the lease's signal.
   *
   * @returns the lease, or `undefined` when the slot holds a run already.
   */
  public leaseForStanding(slotId: string, standing: RunnerSlotStanding, activity: string): StandingSlotLease | undefined {
    const slot = this.slots.find((candidate) => candidate.id === slotId);
    if (slot === undefined || slot.run !== undefined || slot.standing !== undefined) {
      return undefined;
    }
    const held: StandingOnSlot = { report: standing, controller: new AbortController(), spentUsd: 0 };
    slot.standing = held;
    slot.status = RUNNER_SLOT_STATUS.working;
    slot.issueNumber = undefined;
    slot.pr = undefined;
    slot.screen.reset();
    slot.activity = fitBytes(this.redactor.redactText(activity), MAX_TITLE_LENGTH);
    const live = (): boolean => slot.standing === held && !held.controller.signal.aborted;
    return {
      slotId: slot.id,
      slotName: slot.profile.name,
      systemPrompt: systemPrompt(slot.profile),
      signal: held.controller.signal,
      output: (data) => {
        if (live()) {
          slot.screen.write(data);
        }
      },
      activity: (text) => {
        if (live()) {
          slot.activity = fitBytes(this.redactor.redactText(text), MAX_TITLE_LENGTH);
        }
      },
      // Booked whether or not the slot was taken back: a cut-short run's spend is still spent.
      spent: (totalUsd) => {
        if (Number.isFinite(totalUsd) && totalUsd > held.spentUsd) {
          this.ledger.add(totalUsd - held.spentUsd);
          held.spentUsd = totalUsd;
        }
      },
      release: () => {
        if (slot.standing === held) {
          this.freeStanding(slot);
        }
      },
    };
  }

  /** Takes a slot back from its standing run, saying why to the run, and leaves it idle. */
  private endStanding(slot: Slot, why: StandingSlotEnd): void {
    const held = slot.standing;
    if (held === undefined) {
      return;
    }
    this.freeStanding(slot);
    held.controller.abort(why);
  }

  private freeStanding(slot: Slot): void {
    slot.standing = undefined;
    slot.status = RUNNER_SLOT_STATUS.idle;
    slot.activity = "";
  }

  /** Today's spend against the budget, as the sync reports it. */
  public spend(): RunnerSpendReport {
    return this.ledger.report();
  }

  /** The events not yet delivered, oldest first. */
  public pendingEvents(): readonly RunnerWorkEvent[] {
    return this.events;
  }

  /** What came of the CEO's prompts, not yet delivered, oldest first. */
  public pendingPromptOutcomes(): readonly RunnerPromptOutcome[] {
    return this.promptOutcomes;
  }

  /**
   * Forgets the events, by id, that a sync has delivered, and the prompt
   * outcomes it carried: `outcomes` themselves when given, since a kept
   * direction is reported twice under one id, else every one by its command's id.
   */
  public delivered(ids: ReadonlySet<string>, outcomes?: readonly RunnerPromptOutcome[]): void {
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const event = this.events[index];
      if (event !== undefined && ids.has(event.id)) {
        this.events.splice(index, 1);
      }
    }
    const carried = outcomes === undefined ? undefined : new Set(outcomes);
    for (let index = this.promptOutcomes.length - 1; index >= 0; index -= 1) {
      const outcome = this.promptOutcomes[index];
      if (outcome !== undefined && (carried === undefined ? ids.has(outcome.commandId) : carried.has(outcome))) {
        this.promptOutcomes.splice(index, 1);
      }
    }
  }

  /**
   * Whether a standup is on in the office. On, every agent pauses at a safe
   * point and its task timeout is held; off, they carry on from where they
   * were, and each slot types the first direction it kept once its agent is
   * at its prompt.
   */
  public setStandup(on: boolean): void {
    if (on === this.standup) {
      return;
    }
    this.standup = on;
    this.log(on ? "a standup is on in the office: the agents pause at a safe point" : "the standup is over: the agents carry on");
    for (const slot of this.slots) {
      const run = slot.run;
      if (run === undefined || !run.live) {
        continue;
      }
      if (on) {
        run.agentRun.pause?.();
      } else {
        run.agentRun.resume?.();
      }
      this.holdTimeout(slot, run, this.waiting(slot));
      this.deliverKept(slot);
    }
  }

  /** Carries out one command from the server for one of the slots. */
  public handle(command: RunnerSlotCommand): void {
    const slot = this.slots.find((candidate) => candidate.id === command.slotId);
    if (slot === undefined) {
      this.log(`command ${command.id} names no slot of ours (${command.slotId}); ignored`);
      return;
    }
    switch (command.kind) {
      case RUNNER_COMMAND_KIND.start:
        this.start(slot, command);
        return;
      case RUNNER_COMMAND_KIND.stop:
        if (slot.run === undefined) {
          this.debug(`stop for ${slot.id} ignored: it holds no task`);
          return;
        }
        if (command.issueNumber !== undefined && command.issueNumber !== slot.run.issueNumber) {
          // Meant for work the slot has already left behind.
          this.log(`stop for ${slot.id} on #${command.issueNumber} ignored: it is on #${slot.run.issueNumber}`);
          return;
        }
        this.end(slot, RUNNER_EVENT_KIND.failed, `Stopped: ${command.reason || "the server asked"}`);
        return;
      case RUNNER_COMMAND_KIND.prompt:
        if (command.fromCeo === true) {
          this.promptFromCeo(slot, command);
        } else {
          this.log(`${slot.id} given a prompt by the server${slot.run === undefined ? "" : ` on #${slot.run.issueNumber}`}`);
          this.prompt(slot, command.text);
        }
        return;
      case RUNNER_COMMAND_KIND.key:
        this.keyFromCeo(slot, command);
        return;
      case RUNNER_COMMAND_KIND.profile:
        this.setProfile(slot, command);
        return;
    }
  }

  /**
   * Takes the CEO's edit of a slot's agent's profile and keeps it: reported
   * from the next sync, and its agent's system prompt from its next session.
   */
  private setProfile(slot: Slot, command: ProfileCommand): void {
    slot.profile = { name: fitBytes(command.name, MAX_NAME_LENGTH), title: command.title, description: command.description };
    this.options.profiles?.save(new Map(this.slots.map((each) => [each.id, each.profile])));
    const busy = slot.run !== undefined || slot.standing !== undefined;
    this.log(
      `${slot.id} is now ${slot.profile.name}, ${slot.profile.title}, as ${command.requestedBy || "the CEO"} asked` +
        (busy ? "; its agent's prompt changes from its next session" : ""),
    );
  }

  /** Stops every run, as the runner shuts down. */
  public stopAll(): void {
    for (const slot of this.slots) {
      if (slot.run !== undefined) {
        this.end(slot, RUNNER_EVENT_KIND.failed, "Stopped: the runner shut down");
      }
      this.endStanding(slot, STANDING_SLOT_END.shutdown);
    }
  }

  private start(slot: Slot, task: StartCommand): void {
    if (slot.standing !== undefined) {
      // Issue work always comes first: the standing run gives way, and runs again later on a free slot.
      this.log(`${slot.id} gives its standing run for ${slot.standing.report.taskId} up to #${task.issueNumber}`);
      this.endStanding(slot, STANDING_SLOT_END.preempted);
    }
    if (slot.run !== undefined) {
      if (slot.run.issueNumber === task.issueNumber) {
        this.restate(slot, slot.run, task);
        return;
      }
      // A slot holds one task until the server stops it, so this one is refused.
      const busy = `${slot.profile.name} is busy with #${slot.run.issueNumber}`;
      this.emit(slot, RUNNER_EVENT_KIND.failed, task.issueNumber, undefined, busy);
      this.log(`start for ${slot.id} on #${task.issueNumber} refused: ${busy}`);
      return;
    }
    const overBudget = this.ledger.refusal();
    if (overBudget !== undefined) {
      this.emit(slot, RUNNER_EVENT_KIND.failed, task.issueNumber, undefined, overBudget, RUNNER_REFUSAL.budget);
      this.log(`start for ${slot.id} on #${task.issueNumber} refused: ${overBudget}`);
      return;
    }
    slot.status = RUNNER_SLOT_STATUS.starting;
    slot.screen.reset();
    slot.issueNumber = task.issueNumber;
    slot.activity = `Checking #${task.issueNumber} on GitHub`;
    slot.pr = undefined;
    const run: ActiveRun = {
      issueNumber: task.issueNumber,
      task,
      agentRun: { stop: () => undefined },
      timeout: undefined,
      deadline: 0,
      heldMs: undefined,
      live: true,
      started: false,
      workdir: undefined,
      handedIn: false,
      checking: false,
      missing: false,
      spentUsd: 0,
    };
    slot.run = run;
    this.arm(slot, run);
    const { agent } = this.options;
    this.log(
      `${slot.id} starting on #${task.issueNumber} for ${task.requestedBy} with the ${agent.label} agent` +
        (agent.simulated === true ? ": simulated work, nothing real is done on the issue" : ""),
    );
    void this.launch(slot, run, task);
  }

  /**
   * A start for the issue the slot already holds: the server has lost track
   * of it, after a restart say, and gave it out again. The slot says again
   * how far it has got, so the server's work catches up, and anything the
   * start says is a prompt.
   */
  private restate(slot: Slot, run: ActiveRun, task: StartCommand): void {
    this.log(`${slot.id} told again to start on #${run.issueNumber}, which it already holds; it says again how far it has got`);
    if (run.started) {
      this.emit(slot, RUNNER_EVENT_KIND.started, run.issueNumber, undefined, "");
    }
    if (run.handedIn && slot.pr !== undefined) {
      this.emit(slot, RUNNER_EVENT_KIND.prOpened, run.issueNumber, slot.pr, "");
    }
    if (task.note.trim() !== "") {
      this.prompt(slot, task.note);
    }
  }

  /**
   * (Re)starts the task timeout: it measures the agent's work, from a start or
   * a prompt, or carries on with `ms` of it left once a wait is over. During a
   * standup it is set and held at once.
   */
  private arm(slot: Slot, run: ActiveRun, ms = this.options.taskTimeoutMs): void {
    clearTimeout(run.timeout);
    if (this.standup) {
      run.timeout = undefined;
      run.heldMs = ms;
      return;
    }
    run.heldMs = undefined;
    run.deadline = Date.now() + ms;
    const minutes = Math.round(this.options.taskTimeoutMs / 60_000);
    run.timeout = setTimeout(() => {
      if (slot.run === run) {
        this.end(slot, RUNNER_EVENT_KIND.failed, `Timed out after ${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
      }
    }, ms);
    run.timeout.unref();
  }

  /**
   * Holds the task timeout while the agent waits on a person or a standup is
   * on, and lets it run on, from where it was, once the agent is back at its
   * own work. Handed-in work has no timeout to hold or let run.
   */
  private holdTimeout(slot: Slot, run: ActiveRun, waiting: boolean): void {
    if (waiting && run.timeout !== undefined) {
      clearTimeout(run.timeout);
      run.timeout = undefined;
      run.heldMs = Math.max(run.deadline - Date.now(), 0);
    } else if (!waiting && run.heldMs !== undefined) {
      this.arm(slot, run, run.heldMs);
    }
  }

  /**
   * Sets a live run's status, saying `started` first if nothing has yet.
   * `logged` is false for an activity that is a prompt's words, kept out of the log.
   */
  private setStatus(slot: Slot, run: ActiveRun, status: RunnerSlotStatus, activity: string, logged = true): void {
    if (!run.live) {
      return;
    }
    if (!run.started) {
      run.started = true;
      this.emit(slot, RUNNER_EVENT_KIND.started, run.issueNumber, undefined, "");
    }
    this.holdTimeout(slot, run, status === RUNNER_SLOT_STATUS.needsInput || this.standup);
    const was = slot.status;
    slot.status = status;
    slot.activity = fitBytes(this.redactor.redactText(activity), MAX_TITLE_LENGTH);
    this.logStatus(slot, run, was, logged);
  }

  /** What a status change says in the log: a wait on a person always, every step of the work only at `debug`. */
  private logStatus(slot: Slot, run: ActiveRun, was: RunnerSlotStatus, logged: boolean): void {
    const on = `${slot.id} on #${run.issueNumber}`;
    switch (slot.status) {
      case RUNNER_SLOT_STATUS.needsInput:
        this.log(`${on} needs a person: ${slot.activity}`);
        return;
      case RUNNER_SLOT_STATUS.working:
        if (was !== RUNNER_SLOT_STATUS.working) {
          this.log(`${on} is working`);
        }
        if (logged) {
          this.debug(`${on}: ${slot.activity}`);
        }
        return;
      case RUNNER_SLOT_STATUS.idle:
        if (slot.activity === TURN_DONE) {
          this.log(`${on}: its agent's turn ended`);
        } else if (was !== RUNNER_SLOT_STATUS.idle) {
          this.log(`${on}: its agent is up`);
        }
        return;
      case RUNNER_SLOT_STATUS.starting:
      case RUNNER_SLOT_STATUS.exited:
        return;
    }
  }

  /** Gives the slot's agent another turn: the server sent its work back. */
  private prompt(slot: Slot, text: string): void {
    const run = slot.run;
    if (run === undefined || !run.live) {
      this.log(`prompt for ${slot.id} ignored: it holds no task`);
      return;
    }
    if (run.agentRun.prompt === undefined || run.workdir === undefined) {
      this.log(`prompt for ${slot.id} ignored: its agent ${run.workdir === undefined ? "is still starting" : "takes no prompts"}`);
      return;
    }
    run.handedIn = false;
    run.missing = false;
    this.arm(slot, run);
    this.setStatus(slot, run, RUNNER_SLOT_STATUS.working, text.split("\n")[0] ?? "", false);
    run.agentRun.prompt(text);
  }

  /**
   * A prompt the CEO typed: given only while the agent waits at its prompt,
   * and reported either way. A standup's direction for an agent with work in
   * hand that is not at its prompt is kept for when it next is instead.
   */
  private promptFromCeo(slot: Slot, command: PromptCommand): void {
    const outcome = this.promptable(slot);
    if (outcome === RUNNER_PROMPT_OUTCOME.delivered) {
      this.log(`${slot.id} prompted by ${command.requestedBy}${command.queue === true ? " at the standup" : ""}`);
      this.prompt(slot, command.text);
    } else if (command.queue === true && slot.run?.live === true) {
      slot.kept.push(command);
      this.log(`direction for ${slot.id} from ${command.requestedBy} kept for when its agent is next at its prompt: ${outcome}`);
      this.reportOutcome(slot, command.id, RUNNER_PROMPT_OUTCOME.queued);
      return;
    } else {
      this.log(`prompt for ${slot.id} from ${command.requestedBy} not typed: ${outcome}`);
    }
    this.reportOutcome(slot, command.id, outcome);
  }

  /**
   * Types the oldest direction the slot kept, once its agent waits at its
   * prompt with no standup on; one at a time, since typing one starts a turn.
   * A slot whose work has ended reports every one it kept unavailable.
   */
  private deliverKept(slot: Slot): void {
    const run = slot.run;
    if (run === undefined || !run.live) {
      for (const command of slot.kept.splice(0)) {
        this.log(`direction for ${slot.id} from ${command.requestedBy} not typed: its work ended`);
        this.reportOutcome(slot, command.id, RUNNER_PROMPT_OUTCOME.unavailable);
      }
      return;
    }
    if (this.standup || slot.kept.length === 0 || this.promptable(slot) !== RUNNER_PROMPT_OUTCOME.delivered) {
      return;
    }
    const command = slot.kept.shift();
    if (command !== undefined) {
      this.log(`${slot.id} given the direction ${command.requestedBy} gave at the standup`);
      this.prompt(slot, command.text);
      this.reportOutcome(slot, command.id, RUNNER_PROMPT_OUTCOME.delivered);
    }
  }

  /** Whether the slot's task timeout should be held: its agent waits on a person, or a standup is on. */
  private waiting(slot: Slot): boolean {
    return slot.status === RUNNER_SLOT_STATUS.needsInput || this.standup;
  }

  /**
   * A key the CEO pressed: pressed only while the agent waits on a person, on
   * whatever screen it waits at, and reported either way.
   */
  private keyFromCeo(slot: Slot, command: KeyCommand): void {
    const run = slot.run;
    const outcome = this.keyable(slot);
    const label = AGENT_KEY_LABEL[command.key];
    if (outcome === RUNNER_PROMPT_OUTCOME.delivered && run !== undefined) {
      this.log(`${slot.id} on #${run.issueNumber}: ${command.requestedBy} pressed ${label}`);
      run.agentRun.key?.(command.key);
    } else {
      this.log(`key ${label} for ${slot.id} from ${command.requestedBy} not pressed: ${outcome}`);
    }
    this.reportOutcome(slot, command.id, outcome);
  }

  /** Queues what came of the CEO's prompt or key until a sync carrying it is answered. */
  private reportOutcome(slot: Slot, commandId: string, outcome: RunnerPromptOutcomeKind): void {
    this.promptOutcomes.push({ commandId, slotId: slot.id, outcome });
    if (this.promptOutcomes.length > MAX_PENDING_EVENTS) {
      this.promptOutcomes.shift();
    }
  }

  /**
   * Whether the slot's agent waits on a person, so a key answers it, and if
   * not, why. A slot that needs a person only because a turn ended with
   * nothing handed in has its agent at its prompt, where a prompt is the answer.
   */
  private keyable(slot: Slot): RunnerPromptOutcomeKind {
    const run = slot.run;
    if (run === undefined || !run.live) {
      return RUNNER_PROMPT_OUTCOME.unavailable;
    }
    if (slot.status !== RUNNER_SLOT_STATUS.needsInput || run.missing) {
      return RUNNER_PROMPT_OUTCOME.notWaiting;
    }
    return run.agentRun.key === undefined ? RUNNER_PROMPT_OUTCOME.unavailable : RUNNER_PROMPT_OUTCOME.delivered;
  }

  /**
   * Whether the slot's agent waits at its prompt, and if not, why. Its turn
   * is done when the slot is idle with a task, or needs a person only because
   * a turn ended with nothing handed in; a slot still looking for its pull
   * request after a turn is busy until it has. An agent whose wait on a person
   * a prompt answers takes the prompt as that answer.
   */
  private promptable(slot: Slot): RunnerPromptOutcomeKind {
    const run = slot.run;
    if (run === undefined || !run.live || run.workdir === undefined || run.agentRun.prompt === undefined) {
      return slot.status === RUNNER_SLOT_STATUS.starting ? RUNNER_PROMPT_OUTCOME.busy : RUNNER_PROMPT_OUTCOME.unavailable;
    }
    switch (slot.status) {
      case RUNNER_SLOT_STATUS.idle:
        return run.checking ? RUNNER_PROMPT_OUTCOME.busy : RUNNER_PROMPT_OUTCOME.delivered;
      case RUNNER_SLOT_STATUS.needsInput:
        return run.missing || run.agentRun.promptAnswersWait === true ? RUNNER_PROMPT_OUTCOME.delivered : RUNNER_PROMPT_OUTCOME.needsInput;
      case RUNNER_SLOT_STATUS.starting:
      case RUNNER_SLOT_STATUS.working:
        return RUNNER_PROMPT_OUTCOME.busy;
      case RUNNER_SLOT_STATUS.exited:
        return RUNNER_PROMPT_OUTCOME.unavailable;
    }
  }

  /**
   * The agent opened its pull request: its work is handed in, and waits on
   * review rather than the clock. One read off the command that opened it has
   * no title yet, and the card shows it, so it is said once GitHub gives it.
   */
  private handIn(slot: Slot, run: ActiveRun, pr: RunnerPullRequest): void {
    if (!run.live || run.handedIn) {
      return;
    }
    run.handedIn = true;
    run.missing = false;
    clearTimeout(run.timeout);
    run.timeout = undefined;
    run.heldMs = undefined;
    // A simulated one is on no page to look its title up on.
    if (pr.title !== "" || pr.simulated === true) {
      this.sayHandedIn(slot, run, pr);
      return;
    }
    void this.github.pullRequestTitle(pr.number).then((title) => this.sayHandedIn(slot, run, { ...pr, title }));
  }

  private sayHandedIn(slot: Slot, run: ActiveRun, pr: RunnerPullRequest): void {
    if (!run.live || !run.handedIn) {
      return;
    }
    const handed = { ...pr, title: fitBytes(this.redactor.redactText(pr.title), MAX_TITLE_LENGTH) };
    slot.pr = handed;
    this.emit(slot, RUNNER_EVENT_KIND.prOpened, run.issueNumber, handed, "");
    this.log(`${slot.id} handed in #${run.issueNumber}: ${pr.simulated === true ? "a simulated pull request; nothing was opened on GitHub" : pr.url}`);
  }

  /**
   * A turn ended. Unless the agent handed its work in, the slot looks for its
   * pull request, opening one for a branch it pushed without, and says it
   * needs a person when there is none.
   */
  private async afterTurn(slot: Slot, run: ActiveRun): Promise<void> {
    if (run.handedIn || run.checking || run.missing || run.workdir === undefined) {
      return;
    }
    run.checking = true;
    slot.activity = "Looking for its pull request";
    this.debug(`${slot.id} on #${run.issueNumber}: looking for its pull request on GitHub`);
    let pr: RunnerPullRequest | undefined;
    let why = NO_PULL_REQUEST;
    try {
      pr = await this.github.pullRequest({
        issueNumber: run.issueNumber,
        title: run.task.title,
        workdir: run.workdir,
        requestedBy: run.task.requestedBy,
        agentName: slot.profile.name,
      });
    } catch (error) {
      why = `${NO_PULL_REQUEST} that the runner could find: ${(error as Error).message}`;
    } finally {
      run.checking = false;
    }
    if (!run.live || run.handedIn) {
      return;
    }
    if (pr !== undefined) {
      this.handIn(slot, run, pr);
      slot.activity = TURN_DONE;
      return;
    }
    this.debug(`${slot.id} on #${run.issueNumber} found no pull request: ${this.redactor.redactText(why)}`);
    if (slot.status === RUNNER_SLOT_STATUS.idle) {
      run.missing = true;
      this.setStatus(slot, run, RUNNER_SLOT_STATUS.needsInput, why);
    }
  }

  /** Checks the issue on GitHub, opens the task's worktree, then starts its agent there, unless the work ended meanwhile. */
  private async launch(slot: Slot, run: ActiveRun, task: StartCommand): Promise<void> {
    this.debug(`${slot.id} checking #${task.issueNumber} on GitHub`);
    const refusal = await this.github.refusal(task.issueNumber);
    if (!run.live) {
      return;
    }
    if (refusal !== undefined) {
      this.log(`start for ${slot.id} on #${task.issueNumber} refused by its GitHub check`);
      this.end(slot, RUNNER_EVENT_KIND.failed, refusal);
      return;
    }
    slot.activity = "Making a worktree";
    let workdir: string;
    try {
      workdir = await this.options.workspaces.open(slot.id, task.issueNumber);
    } catch (error) {
      if (run.live) {
        this.end(slot, RUNNER_EVENT_KIND.failed, `No worktree: ${(error as Error).message}`);
      }
      return;
    }
    if (!run.live) {
      return;
    }
    run.workdir = workdir;
    slot.activity = "Starting";

    const report = (status: RunnerSlotStatus, activity: string): void => {
      this.setStatus(slot, run, status, activity);
    };
    const reporter: AgentReporter = {
      started: () => report(RUNNER_SLOT_STATUS.idle, ""),
      progress: (activity) => {
        run.missing = false;
        report(RUNNER_SLOT_STATUS.working, activity);
      },
      needsInput: (reason) => {
        report(RUNNER_SLOT_STATUS.needsInput, reason);
        // A wait a prompt answers, as the mock's, is a prompt the agent is at.
        this.deliverKept(slot);
      },
      turnDone: () => {
        // A turn said to have ended twice (a hook, then the screen) keeps saying what the first found.
        if (run.missing || run.checking) {
          return;
        }
        report(RUNNER_SLOT_STATUS.idle, TURN_DONE);
        // Once the slot has looked for its pull request, the agent is at its prompt.
        void this.afterTurn(slot, run).then(() => this.deliverKept(slot));
      },
      output: (data) => {
        if (run.live) {
          slot.screen.write(data);
        }
      },
      prOpened: (pr) => {
        this.handIn(slot, run, pr);
      },
      failed: (message) => {
        if (run.live) {
          this.end(slot, RUNNER_EVENT_KIND.failed, message);
        }
      },
      exited: (message, clean) => {
        if (run.live) {
          const kind = clean ? RUNNER_EVENT_KIND.finished : RUNNER_EVENT_KIND.failed;
          this.end(slot, kind, message, undefined, RUNNER_SLOT_STATUS.exited);
        }
      },
      // Booked whether or not the work is still live: a stopped agent's last turn is paid for too.
      spent: (totalUsd) => {
        if (Number.isFinite(totalUsd)) {
          this.ledger.add(totalUsd - run.spentUsd);
          run.spentUsd = totalUsd;
          this.debug(`${slot.id} on #${run.issueNumber} has spent ${formatUsd(totalUsd)}`);
        }
      },
    };
    let agentRun: AgentRun;
    try {
      agentRun = this.options.agent.start(
        {
          issueNumber: task.issueNumber,
          title: task.title,
          url: task.url,
          note: task.note,
          requestedBy: task.requestedBy,
          workdir,
          systemPrompt: systemPrompt(slot.profile),
        },
        reporter,
      );
    } catch (error) {
      this.end(slot, RUNNER_EVENT_KIND.failed, `The agent did not start: ${(error as Error).message}`);
      return;
    }
    const started = agentRun.process;
    this.log(
      started === undefined
        ? `${slot.id} on #${task.issueNumber}: the ${this.options.agent.label} agent runs inside the runner`
        : `${slot.id} on #${task.issueNumber}: started ${started.command}, pid ${started.pid}`,
    );
    if (run.live) {
      run.agentRun = agentRun;
      if (this.standup) {
        agentRun.pause?.();
      }
    } else {
      // It ended while starting, before its slot had it to stop.
      agentRun.stop();
    }
  }

  /** Ends a slot's run, says how, and leaves the slot free for the next start, `idle` unless its agent `exited`. */
  private end(
    slot: Slot,
    kind: RunnerWorkEventKind,
    message: string,
    pr?: RunnerPullRequest,
    status: RunnerSlotStatus = RUNNER_SLOT_STATUS.idle,
  ): void {
    const run = slot.run;
    if (run === undefined) {
      return;
    }
    run.live = false;
    clearTimeout(run.timeout);
    run.agentRun.stop();
    slot.run = undefined;
    slot.status = status;
    slot.issueNumber = undefined;
    slot.activity = "";
    slot.pr = undefined;
    this.emit(slot, kind, run.issueNumber, pr, message);
    this.deliverKept(slot);
    // The message can quote the agent's last line, so it is masked as its event's is.
    const said = this.redactor.redactText(message);
    this.log(`${slot.id} ${kind} on #${run.issueNumber}${said === "" ? "" : `: ${said}`} (${formatUsd(run.spentUsd)} spent)`);
    void this.options.workspaces.close(slot.id, run.issueNumber);
  }

  private emit(
    slot: Slot,
    kind: RunnerWorkEventKind,
    issueNumber: number,
    pr: RunnerPullRequest | undefined,
    message: string,
    refusal?: RunnerRefusal,
  ): void {
    this.events.push({
      id: this.eventId(),
      kind,
      slotId: slot.id,
      issueNumber,
      pr,
      message: fitBytes(this.redactor.redactText(message), MAX_WORK_NOTE_LENGTH),
      refusal,
    });
    if (this.events.length > MAX_PENDING_EVENTS) {
      this.events.shift();
    }
  }
}
