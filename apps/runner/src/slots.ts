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
 *
 * A slot holding nothing can also be lent to a desk in the office
 * ({@link SlotPool.handle} with `desk-open`): a fresh session of its agent with
 * no issue and no first prompt, in a scratch worktree of the default branch,
 * that the CEO sitting at that desk prompts as any agent is prompted. A slot
 * on a standing run is refused it, and it gives the slot up to an issue's
 * start, since work the office assigned comes first. It has no
 * task timeout and does not pause for a standup: the CEO sitting there is what
 * bounds it, and the server closes it the moment the CEO stands up. Ending,
 * however it ends, stops its agent and discards its worktree; a session that
 * ends without the server asking says so with a `desk-ended` event.
 *
 * The CEO can cancel a slot's task from the office, a `stop` marked
 * `discard`: its worktree and branch go whatever is in them, and its pull
 * request and pushed branch go on GitHub. Firing the slot's agent, `fire`,
 * ends whatever the slot runs, discarding a task the same way, and takes the
 * slot out of the pool: it is reported no more and takes no command, and it
 * stays out across a restart, kept in `./slotIds.ts`.
 *
 * The AI Manager can hire an agent for the CEO, `hire`: a new slot, under the
 * id the server picked and with the profile it wrote, added to the pool up to
 * {@link MAX_RUNNER_SLOTS} and kept, with its profile, across a restart, after
 * the configured slots. From then on it is a slot like any other, given its
 * task by an ordinary `start`, and fired the same way.
 */

import { randomUUID } from "node:crypto";

import {
  AGENT_KEY_LABEL,
  type AgentProfile,
  MAX_NAME_LENGTH,
  MAX_RUNNER_SLOTS,
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
  type RunnerDeskEndedEvent,
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
import type { Agent, AgentReporter, AgentRun, AgentSession } from "./agents/types.js";
import { SpendLedger } from "./budget.js";
import { NO_GITHUB, type TaskGithub } from "./github.js";
import type { SlotIds } from "./slotIds.js";
import type { AgentProfiles } from "./profiles.js";
import { type Redactor, createRedactor } from "./redact.js";
import { SCREEN_COLS, SCREEN_ROWS, ScreenMirror } from "./terminal.js";

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
  /**
   * The task is over, whether or not its directory was ever opened. A task
   * that was cancelled passes `discard`, given the task's branch and a
   * checkout to run in first, and then nothing in its directory is kept.
   * Never rejects.
   */
  close(slotId: string, issueNumber: number, discard?: (branch: string, cwd: string) => Promise<void>): Promise<void>;
}

/** Where a slot's desk sessions work. */
export interface DeskWorkspaces {
  /** A fresh scratch worktree of the default branch for the slot's desk session; rejects with why not. */
  open(slotId: string): Promise<string>;
  /** Discards it, whatever is in it. Never rejects. */
  close(workdir: string): Promise<void>;
}

/** What a desk session's activity says while its worktree is made. */
export const DESK_STARTING = "Making a scratch worktree";

type StartCommand = Extract<RunnerSlotCommand, { kind: typeof RUNNER_COMMAND_KIND.start }>;
type DeskOpenCommand = Extract<RunnerSlotCommand, { kind: typeof RUNNER_COMMAND_KIND.deskOpen }>;
type PromptCommand = Extract<RunnerSlotCommand, { kind: typeof RUNNER_COMMAND_KIND.prompt }>;
type KeyCommand = Extract<RunnerSlotCommand, { kind: typeof RUNNER_COMMAND_KIND.key }>;
type ProfileCommand = Extract<RunnerSlotCommand, { kind: typeof RUNNER_COMMAND_KIND.profile }>;
type DeskResizeCommand = Extract<RunnerSlotCommand, { kind: typeof RUNNER_COMMAND_KIND.deskResize }>;
type FireCommand = Extract<RunnerSlotCommand, { kind: typeof RUNNER_COMMAND_KIND.fire }>;
type HireCommand = Extract<RunnerSlotCommand, { kind: typeof RUNNER_COMMAND_KIND.hire }>;

/** Why a standing run gave its slot up before it finished. */
export const STANDING_SLOT_END = {
  /** An issue's start arrived for the slot, issue work always coming first, or its agent was fired: it runs again on a free slot. */
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

/** A desk session a slot is lent to. */
interface DeskOnSlot {
  readonly seatId: string;
  readonly requestedBy: string;
  agentRun: AgentRun;
  /** Its scratch worktree, once made. */
  workdir: string | undefined;
  /** Cleared the moment it ends, so nothing its agent says afterwards lands. */
  live: boolean;
  /** What its agent has said it cost, in US dollars. */
  spentUsd: number;
  /** Its terminal's size, the CEO's panel's once the server has said; the runner's own until then. */
  cols: number;
  rows: number;
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
  /** Where the slots whose agents were fired are kept, out of the pool; none is kept without it. */
  readonly fired?: SlotIds;
  /** Where the slots the AI Manager hired agents into are kept, back in the pool at the next start; none is kept without it. */
  readonly hired?: SlotIds;
  readonly workspaces: SlotWorkspaces;
  /** Where desk sessions work; without it, the slots are lent to no desk. */
  readonly desks?: DeskWorkspaces;
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
  /** The CEO edited its profile, so it is kept rather than following the default. */
  edited: boolean;
  status: RunnerSlotStatus;
  issueNumber: number | undefined;
  activity: string;
  pr: RunnerPullRequest | undefined;
  run: ActiveRun | undefined;
  /** A standing task's run, which holds the slot instead of an issue until an issue's start takes it back. */
  standing: StandingOnSlot | undefined;
  /** The desk it is lent to, which holds it instead of an issue until the server closes it or an issue's start takes it back. */
  desk: DeskOnSlot | undefined;
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
  private readonly events: Array<RunnerWorkEvent | RunnerDeskEndedEvent> = [];
  private readonly promptOutcomes: RunnerPromptOutcome[] = [];
  private readonly eventId: () => string;
  private readonly log: (line: string) => void;
  private readonly debug: (line: string) => void;
  private readonly redactor: Redactor;
  private readonly github: TaskGithub;
  private readonly ledger: SpendLedger;
  /** Profiles kept for slots beyond this pool's count, saved back unchanged so a smaller pool never loses them. */
  private readonly keptOutsidePool: ReadonlyMap<string, AgentProfile>;
  /** A standup is on in the office, as the server last said. */
  private standup = false;
  /** The slots whose agents were fired, by id, kept out of the pool. */
  private readonly firedIds: Set<string>;
  /** The slots the AI Manager hired agents into, by id, in the order they were hired. */
  private readonly hiredIds: Set<string>;

  public constructor(private readonly options: SlotPoolOptions) {
    this.redactor = options.redactor ?? createRedactor([]);
    this.ledger = options.ledger ?? new SpendLedger({ budgetUsd: undefined });
    this.github = options.github ?? NO_GITHUB;
    this.eventId = options.eventId ?? (() => `event-${randomUUID()}`);
    this.log = options.log ?? (() => undefined);
    this.debug = options.debug ?? (() => undefined);
    const now = Date.now();
    const kept = options.profiles?.load() ?? new Map<string, AgentProfile>();
    this.firedIds = new Set(options.fired?.load() ?? []);
    const configured = Array.from({ length: options.count }, (_, index) => `slot-${index + 1}`);
    this.hiredIds = new Set([...(options.hired?.load() ?? [])].filter((id) => !configured.includes(id) && !this.firedIds.has(id)));
    // Each keeps the index its default name is picked by, whoever before it was fired.
    const ids = [...configured, ...this.hiredIds].map((id, index) => ({ id, index })).filter(({ id }) => !this.firedIds.has(id));
    // More than the server takes would have every sync refused, so the newest hires wait outside.
    const left = ids.splice(MAX_RUNNER_SLOTS).map(({ id }) => id);
    this.slots = ids.map(({ id, index }) => {
      const edited = kept.get(id);
      return this.newSlot(id, edited ?? defaultAgentProfile(options.runnerId ?? "runner", index), edited !== undefined, now);
    });
    if (this.firedIds.size > 0) {
      this.log(`fired, and so not on the floor: ${[...this.firedIds].join(", ")}`);
    }
    if (left.length > 0) {
      this.log(`hired, but not on the floor, which takes ${MAX_RUNNER_SLOTS} slots at most: ${left.join(", ")}`);
    }
    const inPool = new Set(this.slots.map((slot) => slot.id));
    this.keptOutsidePool = new Map([...kept].filter(([id]) => !inPool.has(id)));
  }

  private newSlot(id: string, profile: AgentProfile, edited: boolean, now: number): Slot {
    const screen = new ScreenMirror(now);
    screen.write(`\u001b[2m${profile.name} is waiting for work.\u001b[0m\r\n`);
    return {
      id,
      profile: { ...profile, name: fitBytes(profile.name, MAX_NAME_LENGTH) },
      edited,
      status: RUNNER_SLOT_STATUS.idle,
      issueNumber: undefined,
      activity: "",
      pr: undefined,
      run: undefined,
      standing: undefined,
      desk: undefined,
      screen,
      kept: [],
    };
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
      ...(slot.desk === undefined ? {} : { desk: { seatId: slot.desk.seatId } }),
    }));
  }

  /** The slots free for a standing run: holding no run of any kind. */
  public freeForStanding(): readonly string[] {
    return this.slots
      .filter((slot) => slot.run === undefined && slot.standing === undefined && slot.desk === undefined)
      .map((slot) => slot.id);
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
    if (slot === undefined || slot.run !== undefined || slot.standing !== undefined || slot.desk !== undefined) {
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
  public pendingEvents(): ReadonlyArray<RunnerWorkEvent | RunnerDeskEndedEvent> {
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
    if (slot === undefined && command.kind === RUNNER_COMMAND_KIND.stop && command.discard === true && this.firedIds.has(command.slotId)) {
      // The task of an agent fired with it: the work its slot kept goes too.
      void this.discardKept(command.slotId, command.issueNumber);
      return;
    }
    if (command.kind === RUNNER_COMMAND_KIND.hire) {
      this.hire(command);
      return;
    }
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
          void this.discardKept(slot.id, command.discard === true ? command.issueNumber : undefined);
          return;
        }
        if (command.issueNumber !== undefined && command.issueNumber !== slot.run.issueNumber) {
          // Meant for work the slot has already left behind, whose kept worktree a cancel still discards.
          this.log(`stop for ${slot.id} on #${command.issueNumber} ignored: it is on #${slot.run.issueNumber}`);
          void this.discardKept(slot.id, command.discard === true ? command.issueNumber : undefined);
          return;
        }
        void this.end(
          slot,
          RUNNER_EVENT_KIND.failed,
          `Stopped: ${command.reason || "the server asked"}`,
          undefined,
          RUNNER_SLOT_STATUS.idle,
          command.discard === true,
        );
        return;
      case RUNNER_COMMAND_KIND.prompt:
        if (command.fromCeo === true && slot.desk !== undefined) {
          this.promptDesk(slot, slot.desk, command);
        } else if (command.fromCeo === true) {
          this.promptFromCeo(slot, command);
        } else {
          this.log(`${slot.id} given a prompt by the server${slot.run === undefined ? "" : ` on #${slot.run.issueNumber}`}`);
          this.prompt(slot, command.text);
        }
        return;
      case RUNNER_COMMAND_KIND.key:
        if (slot.desk !== undefined) {
          this.keyDesk(slot, slot.desk, command);
        } else {
          this.keyFromCeo(slot, command);
        }
        return;
      case RUNNER_COMMAND_KIND.deskOpen:
        this.openDesk(slot, command);
        return;
      case RUNNER_COMMAND_KIND.deskClose:
        if (slot.desk?.seatId !== command.seatId) {
          this.debug(`desk-close for ${slot.id} at ${command.seatId} ignored: it is not lent to that desk`);
          return;
        }
        this.log(`${slot.id}'s desk session for ${slot.desk.requestedBy} closed: ${command.reason || "the server asked"}`);
        void this.endDesk(slot, undefined);
        return;
      case RUNNER_COMMAND_KIND.deskResize:
        this.resizeDesk(slot, command);
        return;
      case RUNNER_COMMAND_KIND.profile:
        this.setProfile(slot, command);
        return;
      case RUNNER_COMMAND_KIND.fire:
        this.fire(slot, command);
        return;
    }
  }

  /**
   * Adds the slot the AI Manager hired an agent into, with the profile it
   * wrote, idle until its task's `start`, and keeps both for the next start.
   * Refused, with the reason logged, for an id this runner has had a slot by,
   * or a pool already as large as the server takes.
   */
  private hire(command: HireCommand): void {
    const by = command.requestedBy || "the CEO";
    if (this.slots.some((slot) => slot.id === command.slotId) || this.firedIds.has(command.slotId) || this.hiredIds.has(command.slotId)) {
      this.log(`hire of ${command.name} into ${command.slotId} for ${by} refused: this runner has had a slot by that id`);
      return;
    }
    if (this.slots.length >= MAX_RUNNER_SLOTS) {
      this.log(`hire of ${command.name} for ${by} refused: this runner has ${MAX_RUNNER_SLOTS} slots, the most the server takes`);
      return;
    }
    const slot = this.newSlot(command.slotId, { name: command.name, title: command.title, description: command.description }, true, Date.now());
    this.slots.push(slot);
    this.hiredIds.add(slot.id);
    this.options.hired?.save(this.hiredIds);
    this.saveProfiles();
    this.log(`${slot.id} hired: ${slot.profile.name}, ${slot.profile.title}, for ${by}`);
  }

  /**
   * Lets the slot's agent go: whatever it runs ends, a task discarded as a
   * cancelled one is, and the slot leaves the pool, so no sync reports it and
   * no command reaches it again, this run or the next.
   */
  private fire(slot: Slot, command: FireCommand): void {
    const by = command.requestedBy || "the CEO";
    this.log(`${slot.id}, ${slot.profile.name}, fired by ${by}`);
    void this.end(slot, RUNNER_EVENT_KIND.failed, `Fired by ${by}`, undefined, RUNNER_SLOT_STATUS.idle, true);
    this.endStanding(slot, STANDING_SLOT_END.preempted);
    if (slot.desk !== undefined) {
      void this.endDesk(slot, `${slot.profile.name} was fired`);
    }
    this.slots.splice(this.slots.indexOf(slot), 1);
    this.firedIds.add(slot.id);
    this.options.fired?.save(this.firedIds);
    if (this.hiredIds.delete(slot.id)) {
      this.options.hired?.save(this.hiredIds);
    }
  }

  /**
   * Takes the CEO's edit of a slot's agent's profile and keeps it: reported
   * from the next sync, and its agent's system prompt from its next session.
   */
  private setProfile(slot: Slot, command: ProfileCommand): void {
    slot.profile = { name: fitBytes(command.name, MAX_NAME_LENGTH), title: command.title, description: command.description };
    slot.edited = true;
    this.saveProfiles();
    const busy = slot.run !== undefined || slot.standing !== undefined;
    this.log(
      `${slot.id} is now ${slot.profile.name}, ${slot.profile.title}, as ${command.requestedBy || "the CEO"} asked` +
        (busy ? "; its agent's prompt changes from its next session" : ""),
    );
  }

  private saveProfiles(): void {
    this.options.profiles?.save(
      new Map([...this.keptOutsidePool, ...this.slots.filter((each) => each.edited).map((each) => [each.id, each.profile] as const)]),
    );
  }

  /**
   * Stops every run, as the runner shuts down. Resolves once their agents
   * have exited and their worktrees are given up; a standing run's exit is
   * its scheduler's to wait for.
   */
  public stopAll(): Promise<void> {
    const stopped: Promise<void>[] = [];
    for (const slot of this.slots) {
      if (slot.run !== undefined) {
        stopped.push(this.end(slot, RUNNER_EVENT_KIND.failed, "Stopped: the runner shut down"));
      }
      this.endStanding(slot, STANDING_SLOT_END.shutdown);
      if (slot.desk !== undefined) {
        stopped.push(this.endDesk(slot, "The runner shut down"));
      }
    }
    return Promise.all(stopped).then(() => undefined);
  }

  private start(slot: Slot, task: StartCommand): void {
    if (slot.standing !== undefined) {
      // Issue work always comes first: the standing run gives way, and runs again later on a free slot.
      this.log(`${slot.id} gives its standing run for ${slot.standing.report.taskId} up to #${task.issueNumber}`);
      this.endStanding(slot, STANDING_SLOT_END.preempted);
    }
    if (slot.desk !== undefined) {
      // As for a standing run: the office's issue work comes first.
      this.log(`${slot.id} leaves ${slot.desk.requestedBy}'s desk for #${task.issueNumber}`);
      void this.endDesk(slot, `${slot.profile.name} was taken back for issue #${task.issueNumber}`);
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
      agentRun: { stop: () => Promise.resolve() },
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
        void this.end(slot, RUNNER_EVENT_KIND.failed, `Timed out after ${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
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
      void this.end(slot, RUNNER_EVENT_KIND.failed, refusal);
      return;
    }
    slot.activity = "Making a worktree";
    let workdir: string;
    try {
      workdir = await this.options.workspaces.open(slot.id, task.issueNumber);
    } catch (error) {
      if (run.live) {
        void this.end(slot, RUNNER_EVENT_KIND.failed, `No worktree: ${(error as Error).message}`);
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
          void this.end(slot, RUNNER_EVENT_KIND.failed, message);
        }
      },
      exited: (message, clean) => {
        if (run.live) {
          const kind = clean ? RUNNER_EVENT_KIND.finished : RUNNER_EVENT_KIND.failed;
          void this.end(slot, kind, message, undefined, RUNNER_SLOT_STATUS.exited);
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
      void this.end(slot, RUNNER_EVENT_KIND.failed, `The agent did not start: ${(error as Error).message}`);
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
      void agentRun.stop();
    }
  }

  /**
   * Lends the slot to a desk: a fresh session of its agent, at its prompt, for
   * the CEO sitting there. Refused, with a `desk-ended` event saying why, for a
   * slot holding an issue or a standing run or lent to another desk, past the day's budget, or
   * with an agent or a runner that takes no desk sessions.
   */
  private openDesk(slot: Slot, command: DeskOpenCommand): void {
    if (slot.desk?.seatId === command.seatId) {
      this.debug(`desk-open for ${slot.id} at ${command.seatId} ignored: it is already lent there`);
      return;
    }
    const refusal = this.deskRefusal(slot);
    if (refusal !== undefined) {
      this.emitDesk(slot, command.seatId, refusal);
      this.log(`desk session on ${slot.id} for ${command.requestedBy} refused: ${refusal}`);
      return;
    }
    const desk: DeskOnSlot = {
      seatId: command.seatId,
      requestedBy: command.requestedBy,
      agentRun: { stop: () => Promise.resolve() },
      workdir: undefined,
      live: true,
      spentUsd: 0,
      cols: SCREEN_COLS,
      rows: SCREEN_ROWS,
    };
    slot.desk = desk;
    slot.status = RUNNER_SLOT_STATUS.starting;
    slot.issueNumber = undefined;
    slot.pr = undefined;
    slot.activity = DESK_STARTING;
    slot.screen.reset();
    const { agent } = this.options;
    this.log(
      `${slot.id} lent to ${command.requestedBy}'s desk with the ${agent.label} agent` +
        (agent.simulated === true ? ": a pretend session, nothing real is run" : ""),
    );
    void this.launchDesk(slot, desk);
  }

  /** Why the slot cannot be lent to a desk, or `undefined` when it can. */
  private deskRefusal(slot: Slot): string | undefined {
    if (slot.run !== undefined) {
      return `${slot.profile.name} is busy with #${slot.run.issueNumber}`;
    }
    if (slot.standing !== undefined) {
      return `${slot.profile.name} is busy with ${slot.standing.report.taskId}`;
    }
    if (slot.desk !== undefined) {
      return `${slot.profile.name} is at another desk`;
    }
    if (this.options.desks === undefined || this.options.agent.startSession === undefined) {
      return `The ${this.options.agent.label} agent takes no desk sessions on this runner`;
    }
    return this.ledger.refusal();
  }

  /** Makes the desk session's worktree, then starts its agent there, unless it ended meanwhile. */
  private async launchDesk(slot: Slot, desk: DeskOnSlot): Promise<void> {
    const desks = this.options.desks;
    const startSession = this.options.agent.startSession;
    if (desks === undefined || startSession === undefined) {
      return;
    }
    let workdir: string;
    try {
      workdir = await desks.open(slot.id);
    } catch (error) {
      if (desk.live) {
        void this.endDesk(slot, `No worktree: ${(error as Error).message}`);
      }
      return;
    }
    desk.workdir = workdir;
    if (!desk.live) {
      void desks.close(workdir);
      return;
    }
    slot.activity = "Starting";
    const report = (status: RunnerSlotStatus, activity: string): void => {
      if (desk.live) {
        slot.status = status;
        slot.activity = fitBytes(this.redactor.redactText(activity), MAX_TITLE_LENGTH);
      }
    };
    const reporter: AgentReporter = {
      started: () => report(RUNNER_SLOT_STATUS.idle, ""),
      progress: (activity) => report(RUNNER_SLOT_STATUS.working, activity),
      needsInput: (reason) => {
        report(RUNNER_SLOT_STATUS.needsInput, reason);
        if (desk.live) {
          this.log(`${slot.id} at ${desk.requestedBy}'s desk needs a person: ${slot.activity}`);
        }
      },
      turnDone: () => report(RUNNER_SLOT_STATUS.idle, TURN_DONE),
      output: (data) => {
        if (desk.live) {
          slot.screen.write(data);
        }
      },
      // Nothing to hand in: a pull request it opens at the CEO's word is on GitHub for the CEO to see.
      prOpened: (pr) => {
        if (desk.live) {
          this.log(`${slot.id} at ${desk.requestedBy}'s desk opened ${pr.simulated === true ? "a simulated pull request" : pr.url}`);
        }
      },
      failed: (message) => {
        if (desk.live) {
          void this.endDesk(slot, message);
        }
      },
      exited: (message) => {
        if (desk.live) {
          void this.endDesk(slot, message);
        }
      },
      // Booked whether or not it is still live, as a task's is.
      spent: (totalUsd) => {
        if (Number.isFinite(totalUsd)) {
          this.ledger.add(totalUsd - desk.spentUsd);
          desk.spentUsd = totalUsd;
          this.debug(`${slot.id} at ${desk.requestedBy}'s desk has spent ${formatUsd(totalUsd)}`);
        }
      },
    };
    const session: AgentSession = { requestedBy: desk.requestedBy, workdir, systemPrompt: systemPrompt(slot.profile) };
    let agentRun: AgentRun;
    try {
      agentRun = startSession.call(this.options.agent, session, reporter);
    } catch (error) {
      void this.endDesk(slot, `The agent did not start: ${(error as Error).message}`);
      return;
    }
    const started = agentRun.process;
    this.log(
      started === undefined
        ? `${slot.id} at ${desk.requestedBy}'s desk: the ${this.options.agent.label} agent runs inside the runner`
        : `${slot.id} at ${desk.requestedBy}'s desk: started ${started.command}, pid ${started.pid}`,
    );
    if (desk.live) {
      desk.agentRun = agentRun;
      // Sized while its worktree was made: the agent starts at the runner's size.
      if (desk.cols !== SCREEN_COLS || desk.rows !== SCREEN_ROWS) {
        agentRun.resize?.(desk.cols, desk.rows);
      }
    } else {
      void agentRun.stop();
    }
  }

  /** Sizes the desk session's terminal, and its agent's, to the CEO's panel. */
  private resizeDesk(slot: Slot, command: DeskResizeCommand): void {
    const desk = slot.desk;
    if (desk?.seatId !== command.seatId) {
      this.debug(`desk-resize for ${slot.id} at ${command.seatId} ignored: it is not lent to that desk`);
      return;
    }
    desk.cols = command.cols;
    desk.rows = command.rows;
    slot.screen.resize(command.cols, command.rows);
    desk.agentRun.resize?.(command.cols, command.rows);
  }

  /**
   * A prompt the CEO typed at the desk: given only while its agent waits at
   * its prompt, and reported either way. A standup's direction is not kept for
   * a desk session, since the CEO is the one at its desk.
   */
  private promptDesk(slot: Slot, desk: DeskOnSlot, command: PromptCommand): void {
    const outcome = this.deskPromptable(slot, desk);
    if (outcome === RUNNER_PROMPT_OUTCOME.delivered) {
      this.log(`${slot.id} at ${desk.requestedBy}'s desk prompted by ${command.requestedBy}`);
      slot.status = RUNNER_SLOT_STATUS.working;
      slot.activity = fitBytes(this.redactor.redactText(command.text.split("\n")[0] ?? ""), MAX_TITLE_LENGTH);
      desk.agentRun.prompt?.(command.text);
    } else {
      this.log(`prompt for ${slot.id} at ${desk.requestedBy}'s desk from ${command.requestedBy} not typed: ${outcome}`);
    }
    this.reportOutcome(slot, command.id, outcome);
  }

  /** Whether the desk session's agent waits at its prompt, and if not, why; as {@link promptable} for a task. */
  private deskPromptable(slot: Slot, desk: DeskOnSlot): RunnerPromptOutcomeKind {
    if (!desk.live || desk.agentRun.prompt === undefined) {
      return slot.status === RUNNER_SLOT_STATUS.starting ? RUNNER_PROMPT_OUTCOME.busy : RUNNER_PROMPT_OUTCOME.unavailable;
    }
    switch (slot.status) {
      case RUNNER_SLOT_STATUS.idle:
        return RUNNER_PROMPT_OUTCOME.delivered;
      case RUNNER_SLOT_STATUS.needsInput:
        return desk.agentRun.promptAnswersWait === true ? RUNNER_PROMPT_OUTCOME.delivered : RUNNER_PROMPT_OUTCOME.needsInput;
      case RUNNER_SLOT_STATUS.starting:
      case RUNNER_SLOT_STATUS.working:
        return RUNNER_PROMPT_OUTCOME.busy;
      case RUNNER_SLOT_STATUS.exited:
        return RUNNER_PROMPT_OUTCOME.unavailable;
    }
  }

  /** A key the CEO pressed at the desk: pressed only while its agent waits on a person, and reported either way. */
  private keyDesk(slot: Slot, desk: DeskOnSlot, command: KeyCommand): void {
    const label = AGENT_KEY_LABEL[command.key];
    let outcome: RunnerPromptOutcomeKind;
    if (!desk.live || desk.agentRun.key === undefined) {
      outcome = RUNNER_PROMPT_OUTCOME.unavailable;
    } else if (slot.status !== RUNNER_SLOT_STATUS.needsInput) {
      outcome = RUNNER_PROMPT_OUTCOME.notWaiting;
    } else {
      outcome = RUNNER_PROMPT_OUTCOME.delivered;
    }
    if (outcome === RUNNER_PROMPT_OUTCOME.delivered) {
      this.log(`${slot.id} at ${desk.requestedBy}'s desk: ${command.requestedBy} pressed ${label}`);
      desk.agentRun.key?.(command.key);
    } else {
      this.log(`key ${label} for ${slot.id} at ${desk.requestedBy}'s desk not pressed: ${outcome}`);
    }
    this.reportOutcome(slot, command.id, outcome);
  }

  /**
   * Ends the slot's desk session, stopping its agent and discarding its
   * worktree once it has exited, and leaves the slot idle. `message` says why
   * when the server did not ask for it, as a `desk-ended` event; `undefined`
   * when it did. Resolves once the worktree is discarded.
   */
  private endDesk(slot: Slot, message: string | undefined): Promise<void> {
    const desk = slot.desk;
    if (desk === undefined) {
      return Promise.resolve();
    }
    desk.live = false;
    const stopped = desk.agentRun.stop();
    slot.desk = undefined;
    slot.status = RUNNER_SLOT_STATUS.idle;
    slot.activity = "";
    // Issue work is run at the runner's own size, whatever the CEO's panel was.
    slot.screen.resize(SCREEN_COLS, SCREEN_ROWS);
    if (message !== undefined) {
      this.emitDesk(slot, desk.seatId, message);
      this.log(`${slot.id}'s desk session for ${desk.requestedBy} ended: ${this.redactor.redactText(message)}`);
    }
    this.log(`${slot.id} is back from ${desk.requestedBy}'s desk (${formatUsd(desk.spentUsd)} spent)`);
    const { workdir } = desk;
    return workdir === undefined ? stopped : stopped.then(() => this.options.desks?.close(workdir));
  }

  private emitDesk(slot: Slot, seatId: string, message: string): void {
    this.events.push({
      id: this.eventId(),
      kind: RUNNER_EVENT_KIND.deskEnded,
      slotId: slot.id,
      seatId,
      message: fitBytes(this.redactor.redactText(message), MAX_WORK_NOTE_LENGTH),
    });
    if (this.events.length > MAX_PENDING_EVENTS) {
      this.events.shift();
    }
  }

  /**
   * Ends a slot's run, says how, and leaves the slot free for the next start,
   * `idle` unless its agent `exited`. A `discard`ed run's pull request and
   * pushed branch go on GitHub first, then its worktree and branch, whatever
   * is in them. Its worktree is touched only once its agent has exited, since
   * one still writing to it could look clean and be removed under it; resolves
   * once it is given up.
   */
  private end(
    slot: Slot,
    kind: RunnerWorkEventKind,
    message: string,
    pr?: RunnerPullRequest,
    status: RunnerSlotStatus = RUNNER_SLOT_STATUS.idle,
    discard = false,
  ): Promise<void> {
    const run = slot.run;
    if (run === undefined) {
      return Promise.resolve();
    }
    run.live = false;
    clearTimeout(run.timeout);
    const stopped = run.agentRun.stop();
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
    return stopped.then(() =>
      discard ? this.discardKept(slot.id, run.issueNumber) : this.options.workspaces.close(slot.id, run.issueNumber),
    );
  }

  /**
   * Throws a cancelled task's work away: its pull request and pushed branch
   * on GitHub, even once its worktree is gone, then its worktree and branch,
   * whatever is in them.
   */
  private discardKept(slotId: string, issueNumber: number | undefined): Promise<void> {
    if (issueNumber === undefined) {
      return Promise.resolve();
    }
    return this.options.workspaces.close(slotId, issueNumber, async (branch, cwd) => {
      const failed = await this.github.discard(branch, cwd);
      this.log(
        failed === undefined
          ? `${slotId} discarded its work on #${issueNumber}`
          : `${slotId} could not discard its work on #${issueNumber} on GitHub: ${failed}`,
      );
    });
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
