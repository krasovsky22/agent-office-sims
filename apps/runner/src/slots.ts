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
 * Everything an agent says is cut to the contract's byte budgets here, before
 * it is queued: the server refuses a whole sync for one string too long, and
 * one chatty agent must not stall every slot's report. It is masked first
 * too, as its screen is (`./redact.ts`), since it goes to every client.
 *
 * Each slot also has a terminal screen, `./terminal.ts`, which shows what its
 * agent prints. A new run starts on a cleared screen, and the last run's
 * screen stays up until then.
 */

import { randomUUID } from "node:crypto";

import {
  MAX_NAME_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_WORK_NOTE_LENGTH,
  RUNNER_COMMAND_KIND,
  RUNNER_EVENT_KIND,
  RUNNER_SLOT_STATUS,
  type RunnerCommand,
  type RunnerEvent,
  type RunnerEventKind,
  type RunnerPullRequest,
  type RunnerSlotReport,
  type RunnerSlotStatus,
} from "@sim/shared";

import type { Agent, AgentReporter, AgentRun } from "./agents/types.js";
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

/** Where a slot's tasks work. */
export interface SlotWorkspaces {
  /** A working directory for the task, ready to work in; rejects with why not. */
  open(slotId: string, issueNumber: number): Promise<string>;
  /** The task is over, whether or not its directory was ever opened. Never rejects. */
  close(slotId: string, issueNumber: number): Promise<void>;
}

type StartCommand = Extract<RunnerCommand, { kind: typeof RUNNER_COMMAND_KIND.start }>;

export interface SlotPoolOptions {
  readonly count: number;
  readonly agent: Agent;
  readonly workspaces: SlotWorkspaces;
  readonly taskTimeoutMs: number;
  /** Masks the runner's secrets in what its agents say; none by default. */
  readonly redactor?: Redactor;
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
  agentRun: AgentRun;
  readonly timeout: ReturnType<typeof setTimeout>;
  /** Cleared the moment the work ends, so nothing the agent says afterwards lands. */
  live: boolean;
  /** Whether its `started` event has been queued. */
  started: boolean;
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
  private readonly eventId: () => string;
  private readonly log: (line: string) => void;
  private readonly redactor: Redactor;

  public constructor(private readonly options: SlotPoolOptions) {
    this.redactor = options.redactor ?? createRedactor([]);
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

  /** The events not yet delivered, oldest first. */
  public pendingEvents(): readonly RunnerEvent[] {
    return this.events;
  }

  /** Forgets events a sync has delivered. */
  public delivered(ids: ReadonlySet<string>): void {
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const event = this.events[index];
      if (event !== undefined && ids.has(event.id)) {
        this.events.splice(index, 1);
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
        if (slot.run !== undefined) {
          this.end(slot, RUNNER_EVENT_KIND.failed, `Stopped: ${command.reason || "the server asked"}`);
        }
        return;
      case RUNNER_COMMAND_KIND.prompt:
        // Talking to a running agent is a later slice's; the command is acked
        // so the server stops sending it.
        this.log(`prompt for ${slot.id} ignored: ${this.options.agent.label} agents take no prompts`);
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
      // The server only starts an idle slot, so this is a race with work the
      // runner has not reported yet; the issue it asked for is the one refused.
      this.emit(slot, RUNNER_EVENT_KIND.failed, task.issueNumber, undefined, `${slot.name} is busy with #${slot.run.issueNumber}`);
      return;
    }
    const minutes = Math.round(this.options.taskTimeoutMs / 60_000);
    const timeout = setTimeout(() => {
      if (slot.run === run) {
        this.end(slot, RUNNER_EVENT_KIND.failed, `Timed out after ${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
      }
    }, this.options.taskTimeoutMs);
    timeout.unref();

    slot.status = RUNNER_SLOT_STATUS.starting;
    slot.screen.reset();
    slot.issueNumber = task.issueNumber;
    slot.activity = "Making a worktree";
    slot.pr = undefined;
    const run: ActiveRun = {
      issueNumber: task.issueNumber,
      agentRun: { stop: () => undefined },
      timeout,
      live: true,
      started: false,
    };
    slot.run = run;
    this.log(`${slot.id} starting on #${task.issueNumber} for ${task.requestedBy}`);
    void this.launch(slot, run, task);
  }

  /** Opens the task's worktree, then starts its agent there, unless the work ended meanwhile. */
  private async launch(slot: Slot, run: ActiveRun, task: StartCommand): Promise<void> {
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
    slot.activity = "Starting";

    /** Sets the slot's status while the work is live, saying `started` first if nothing has yet. */
    const report = (status: RunnerSlotStatus, activity: string): void => {
      if (!run.live) {
        return;
      }
      if (!run.started) {
        run.started = true;
        this.emit(slot, RUNNER_EVENT_KIND.started, run.issueNumber, undefined, "");
      }
      slot.status = status;
      slot.activity = fitBytes(this.redactor.redactText(activity), MAX_TITLE_LENGTH);
    };
    const reporter: AgentReporter = {
      started: () => report(RUNNER_SLOT_STATUS.idle, ""),
      progress: (activity) => report(RUNNER_SLOT_STATUS.working, activity),
      needsInput: (reason) => report(RUNNER_SLOT_STATUS.needsInput, reason),
      turnDone: () => report(RUNNER_SLOT_STATUS.idle, TURN_DONE),
      output: (data) => {
        if (run.live) {
          slot.screen.write(data);
        }
      },
      prOpened: (pr) => {
        if (!run.live) {
          return;
        }
        this.end(slot, RUNNER_EVENT_KIND.prOpened, "", { ...pr, title: fitBytes(this.redactor.redactText(pr.title), MAX_TITLE_LENGTH) });
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
    this.log(`${slot.id} ${kind} on #${run.issueNumber}${message === "" ? "" : `: ${message}`}`);
    void this.options.workspaces.close(slot.id, run.issueNumber);
  }

  private emit(
    slot: Slot,
    kind: RunnerEventKind,
    issueNumber: number,
    pr: RunnerPullRequest | undefined,
    message: string,
  ): void {
    this.events.push({
      id: this.eventId(),
      kind,
      slotId: slot.id,
      issueNumber,
      pr,
      message: fitBytes(this.redactor.redactText(message), MAX_WORK_NOTE_LENGTH),
    });
    if (this.events.length > MAX_PENDING_EVENTS) {
      this.events.shift();
    }
  }
}
