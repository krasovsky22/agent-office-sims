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
 * agent starts, the issue is checked on GitHub for the eligibility label. Once
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
 * sync carrying the report is answered.
 */

import { randomUUID } from "node:crypto";

import {
  MAX_NAME_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_WORK_NOTE_LENGTH,
  RUNNER_COMMAND_KIND,
  RUNNER_EVENT_KIND,
  RUNNER_PROMPT_OUTCOME,
  RUNNER_REFUSAL,
  RUNNER_SLOT_STATUS,
  type RunnerCommand,
  type RunnerEvent,
  type RunnerEventKind,
  type RunnerPromptOutcome,
  type RunnerPromptOutcomeKind,
  type RunnerPullRequest,
  type RunnerRefusal,
  type RunnerSlotReport,
  type RunnerSlotStatus,
  type RunnerSpendReport,
  formatUsd,
} from "@sim/shared";

import type { Agent, AgentReporter, AgentRun } from "./agents/types.js";
import { SpendLedger } from "./budget.js";
import { NO_GITHUB, type TaskGithub } from "./github.js";
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

type StartCommand = Extract<RunnerCommand, { kind: typeof RUNNER_COMMAND_KIND.start }>;
type PromptCommand = Extract<RunnerCommand, { kind: typeof RUNNER_COMMAND_KIND.prompt }>;

export interface SlotPoolOptions {
  readonly count: number;
  readonly agent: Agent;
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
}

interface Slot {
  readonly id: string;
  readonly name: string;
  status: RunnerSlotStatus;
  issueNumber: number | undefined;
  activity: string;
  pr: RunnerPullRequest | undefined;
  run: ActiveRun | undefined;
  readonly screen: ScreenMirror;
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

/** The bytes a string takes in a sync body, as the contract measures them. */
function encodedBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value)) - 2;
}

/** Cuts a string to fit a byte budget, whole characters at a time. */
export function fitBytes(value: string, maxBytes: number): string {
  if (encodedBytes(value) <= maxBytes) {
    return value;
  }
  let used = 0;
  let end = 0;
  for (const character of value) {
    used += encodedBytes(character);
    if (used > maxBytes) {
      break;
    }
    end += character.length;
  }
  return value.slice(0, end);
}

export class SlotPool {
  private readonly slots: Slot[];
  private readonly events: RunnerEvent[] = [];
  private readonly promptOutcomes: RunnerPromptOutcome[] = [];
  private readonly eventId: () => string;
  private readonly log: (line: string) => void;
  private readonly redactor: Redactor;
  private readonly github: TaskGithub;
  private readonly ledger: SpendLedger;

  public constructor(private readonly options: SlotPoolOptions) {
    this.redactor = options.redactor ?? createRedactor([]);
    this.ledger = options.ledger ?? new SpendLedger({ budgetUsd: undefined });
    this.github = options.github ?? NO_GITHUB;
    this.eventId = options.eventId ?? (() => `event-${randomUUID()}`);
    this.log = options.log ?? (() => undefined);
    const now = Date.now();
    this.slots = Array.from({ length: options.count }, (_, index) => {
      const name = fitBytes(`${options.agent.label} ${index + 1}`, MAX_NAME_LENGTH);
      const screen = new ScreenMirror(now);
      screen.write(`\u001b[2m${name} is waiting for work.\u001b[0m\r\n`);
      return {
        id: `slot-${index + 1}`,
        name,
        status: RUNNER_SLOT_STATUS.idle,
        issueNumber: undefined,
        activity: "",
        pr: undefined,
        run: undefined,
        screen,
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
      name: slot.name,
      status: slot.status,
      issueNumber: slot.issueNumber,
      activity: slot.activity,
      pr: slot.pr,
    }));
  }

  /** Today's spend against the budget, as the sync reports it. */
  public spend(): RunnerSpendReport {
    return this.ledger.report();
  }

  /** The events not yet delivered, oldest first. */
  public pendingEvents(): readonly RunnerEvent[] {
    return this.events;
  }

  /** What came of the CEO's prompts, not yet delivered, oldest first. */
  public pendingPromptOutcomes(): readonly RunnerPromptOutcome[] {
    return this.promptOutcomes;
  }

  /** Forgets the events, and the prompt outcomes by their command's id, that a sync has delivered. */
  public delivered(ids: ReadonlySet<string>): void {
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const event = this.events[index];
      if (event !== undefined && ids.has(event.id)) {
        this.events.splice(index, 1);
      }
    }
    for (let index = this.promptOutcomes.length - 1; index >= 0; index -= 1) {
      const outcome = this.promptOutcomes[index];
      if (outcome !== undefined && ids.has(outcome.commandId)) {
        this.promptOutcomes.splice(index, 1);
      }
    }
  }

  /** Carries out one command from the server. */
  public handle(command: RunnerCommand): void {
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
          this.prompt(slot, command.text);
        }
        return;
    }
  }

  /** Stops every run, as the runner shuts down. */
  public stopAll(): void {
    for (const slot of this.slots) {
      if (slot.run !== undefined) {
        this.end(slot, RUNNER_EVENT_KIND.failed, "Stopped: the runner shut down");
      }
    }
  }

  private start(slot: Slot, task: StartCommand): void {
    if (slot.run !== undefined) {
      if (slot.run.issueNumber === task.issueNumber) {
        this.restate(slot, slot.run, task);
        return;
      }
      // A slot holds one task until the server stops it, so this one is refused.
      this.emit(slot, RUNNER_EVENT_KIND.failed, task.issueNumber, undefined, `${slot.name} is busy with #${slot.run.issueNumber}`);
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
    this.log(`${slot.id} starting on #${task.issueNumber} for ${task.requestedBy}`);
    void this.launch(slot, run, task);
  }

  /**
   * A start for the issue the slot already holds: the server has lost track
   * of it, after a restart say, and gave it out again. The slot says again
   * how far it has got, so the server's work catches up, and anything the
   * start says is a prompt.
   */
  private restate(slot: Slot, run: ActiveRun, task: StartCommand): void {
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
   * a prompt, or carries on with `ms` of it left once a wait is over.
   */
  private arm(slot: Slot, run: ActiveRun, ms = this.options.taskTimeoutMs): void {
    clearTimeout(run.timeout);
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
   * Holds the task timeout while the agent waits on a person, and lets it run
   * on, from where it was, once the agent is back at its own work. Handed-in
   * work has no timeout to hold or let run.
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

  /** Sets a live run's status, saying `started` first if nothing has yet. */
  private setStatus(slot: Slot, run: ActiveRun, status: RunnerSlotStatus, activity: string): void {
    if (!run.live) {
      return;
    }
    if (!run.started) {
      run.started = true;
      this.emit(slot, RUNNER_EVENT_KIND.started, run.issueNumber, undefined, "");
    }
    this.holdTimeout(slot, run, status === RUNNER_SLOT_STATUS.needsInput);
    slot.status = status;
    slot.activity = fitBytes(this.redactor.redactText(activity), MAX_TITLE_LENGTH);
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
    this.setStatus(slot, run, RUNNER_SLOT_STATUS.working, text.split("\n")[0] ?? "");
    run.agentRun.prompt(text);
  }

  /**
   * A prompt the CEO typed: given only while the agent waits at its prompt,
   * and reported either way.
   */
  private promptFromCeo(slot: Slot, command: PromptCommand): void {
    const outcome = this.promptable(slot);
    if (outcome === RUNNER_PROMPT_OUTCOME.delivered) {
      this.log(`${slot.id} prompted by ${command.requestedBy}`);
      this.prompt(slot, command.text);
    } else {
      this.log(`prompt for ${slot.id} from ${command.requestedBy} not typed: ${outcome}`);
    }
    this.promptOutcomes.push({ commandId: command.id, slotId: slot.id, outcome });
    if (this.promptOutcomes.length > MAX_PENDING_EVENTS) {
      this.promptOutcomes.shift();
    }
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
    let pr: RunnerPullRequest | undefined;
    let why = NO_PULL_REQUEST;
    try {
      pr = await this.github.pullRequest({
        issueNumber: run.issueNumber,
        title: run.task.title,
        workdir: run.workdir,
        requestedBy: run.task.requestedBy,
        agentName: slot.name,
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
    if (slot.status === RUNNER_SLOT_STATUS.idle) {
      run.missing = true;
      this.setStatus(slot, run, RUNNER_SLOT_STATUS.needsInput, why);
    }
  }

  /** Checks the issue on GitHub, opens the task's worktree, then starts its agent there, unless the work ended meanwhile. */
  private async launch(slot: Slot, run: ActiveRun, task: StartCommand): Promise<void> {
    const refusal = await this.github.refusal(task.issueNumber);
    if (!run.live) {
      return;
    }
    if (refusal !== undefined) {
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
      needsInput: (reason) => report(RUNNER_SLOT_STATUS.needsInput, reason),
      turnDone: () => {
        // A turn said to have ended twice (a hook, then the screen) keeps saying what the first found.
        if (run.missing || run.checking) {
          return;
        }
        report(RUNNER_SLOT_STATUS.idle, TURN_DONE);
        void this.afterTurn(slot, run);
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
        },
        reporter,
      );
    } catch (error) {
      this.end(slot, RUNNER_EVENT_KIND.failed, `The agent did not start: ${(error as Error).message}`);
      return;
    }
    if (run.live) {
      run.agentRun = agentRun;
    } else {
      // It ended while starting, before its slot had it to stop.
      agentRun.stop();
    }
  }

  /** Ends a slot's run, says how, and leaves the slot free for the next start, `idle` unless its agent `exited`. */
  private end(
    slot: Slot,
    kind: RunnerEventKind,
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
    this.log(`${slot.id} ${kind} on #${run.issueNumber}${message === "" ? "" : `: ${message}`} (${formatUsd(run.spentUsd)} spent)`);
    void this.options.workspaces.close(slot.id, run.issueNumber);
  }

  private emit(
    slot: Slot,
    kind: RunnerEventKind,
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
