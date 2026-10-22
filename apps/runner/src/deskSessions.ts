/**
 * The desk sessions a runner's slots are lent to.
 *
 * A slot holding nothing can be lent to a desk in the office (a `desk-open`
 * command): a fresh session of its agent with no issue and no first prompt,
 * in a scratch worktree of the default branch, that the player sitting at that
 * desk prompts as any agent is prompted. The pool in `./slots.ts` decides
 * which slot and when; this is what a session on one does, from its start to
 * its end. It has no task timeout and does not pause for a standup: its player
 * turning the desk's computer off is what bounds it. Ending, however it ends, stops its agent
 * and discards its worktree; a session that ends without the server asking
 * says so with a `desk-ended` event.
 */

import {
  AGENT_KEY_LABEL,
  MAX_TITLE_LENGTH,
  MAX_WORK_NOTE_LENGTH,
  RUNNER_COMMAND_KIND,
  RUNNER_EVENT_KIND,
  RUNNER_PROMPT_OUTCOME,
  RUNNER_SLOT_STATUS,
  type RunnerDeskEndedEvent,
  type RunnerPromptOutcomeKind,
  type RunnerSlotCommand,
  type RunnerSlotStatus,
  type RunnerWorkEvent,
  fitJsonBytes,
  formatUsd,
} from "@sim/shared";

import { systemPrompt } from "./agents/prompt.js";
import type { Agent, AgentRun, AgentSession } from "./agents/types.js";
import type { SpendLedger } from "./budget.js";
import type { EventOutbox } from "./eventOutbox.js";
import type { Redactor } from "./redact.js";
import { TURN_DONE, keyOutcome, promptOutcome, runReporter } from "./slotRuns.js";
import type { KeyCommand, PromptCommand, Slot } from "./slots.js";
import { SCREEN_COLS, SCREEN_ROWS } from "./terminal.js";

/** Where a slot's desk sessions work. */
export interface DeskWorkspaces {
  /** A fresh scratch worktree of the default branch for the slot's desk session; rejects with why not. */
  open(slotId: string): Promise<string>;
  /** Discards it, whatever is in it. Never rejects. */
  close(workdir: string): Promise<void>;
}

/** What a desk session's activity says while its worktree is made. */
const DESK_STARTING = "Making a scratch worktree";

type DeskOpenCommand = Extract<RunnerSlotCommand, { kind: typeof RUNNER_COMMAND_KIND.deskOpen }>;
type DeskCloseCommand = Extract<RunnerSlotCommand, { kind: typeof RUNNER_COMMAND_KIND.deskClose }>;
type DeskResizeCommand = Extract<RunnerSlotCommand, { kind: typeof RUNNER_COMMAND_KIND.deskResize }>;

/** A desk session a slot is lent to. */
export interface DeskOnSlot {
  readonly seatId: string;
  readonly requestedBy: string;
  agentRun: AgentRun;
  /** Its scratch worktree, once made. */
  workdir: string | undefined;
  /** Cleared the moment it ends, so nothing its agent says afterwards lands. */
  live: boolean;
  /** What its agent has said it cost, in US dollars. */
  spentUsd: number;
  /** Its terminal's size, its player's panel's once the server has said; the runner's own until then. */
  cols: number;
  rows: number;
}

/** What the desk sessions need of the slot pool. */
export interface DeskSessionsHost {
  readonly agent: Agent;
  /** Where desk sessions work; without it, the slots are lent to no desk. */
  readonly desks: DeskWorkspaces | undefined;
  readonly ledger: SpendLedger;
  readonly redactor: Redactor;
  /** The pool's events, where a `desk-ended` waits for a sync with the rest. */
  readonly events: Pick<EventOutbox<RunnerWorkEvent | RunnerDeskEndedEvent>, "push">;
  readonly eventId: () => string;
  readonly log: (line: string) => void;
  readonly debug: (line: string) => void;
  /** Queues what came of its player's prompt or key until a sync carrying it is answered. */
  readonly reportOutcome: (slot: Slot, commandId: string, outcome: RunnerPromptOutcomeKind) => void;
}

export class DeskSessions {
  public constructor(private readonly host: DeskSessionsHost) {}

  /**
   * Lends the slot to a desk: a fresh session of its agent, at its prompt, for
   * the player sitting there. Refused, with a `desk-ended` event saying why, for a
   * slot holding an issue or a standing run or lent to another desk, past the day's budget, or
   * with an agent or a runner that takes no desk sessions.
   */
  public open(slot: Slot, command: DeskOpenCommand): void {
    if (slot.desk?.seatId === command.seatId) {
      this.host.debug(`desk-open for ${slot.id} at ${command.seatId} ignored: it is already lent there`);
      return;
    }
    const refusal = this.refusal(slot);
    if (refusal !== undefined) {
      this.emit(slot, command.seatId, refusal);
      this.host.log(`desk session on ${slot.id} for ${command.requestedBy} refused: ${refusal}`);
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
    const { agent } = this.host;
    this.host.log(
      `${slot.id} lent to ${command.requestedBy}'s desk with the ${agent.label} agent` +
        (agent.simulated === true ? ": a pretend session, nothing real is run" : ""),
    );
    void this.launch(slot, desk);
  }

  /** Why the slot cannot be lent to a desk, or `undefined` when it can. */
  private refusal(slot: Slot): string | undefined {
    if (slot.run !== undefined) {
      return `${slot.profile.name} is busy with #${slot.run.issueNumber}`;
    }
    if (slot.standing !== undefined) {
      return `${slot.profile.name} is busy with ${slot.standing.report.taskId}`;
    }
    if (slot.desk !== undefined) {
      return `${slot.profile.name} is at another desk`;
    }
    if (this.host.desks === undefined || this.host.agent.startSession === undefined) {
      return `The ${this.host.agent.label} agent takes no desk sessions on this runner`;
    }
    return this.host.ledger.refusal();
  }

  /** Makes the desk session's worktree, then starts its agent there, unless it ended meanwhile. */
  private async launch(slot: Slot, desk: DeskOnSlot): Promise<void> {
    const desks = this.host.desks;
    const startSession = this.host.agent.startSession;
    if (desks === undefined || startSession === undefined) {
      return;
    }
    let workdir: string;
    try {
      workdir = await desks.open(slot.id);
    } catch (error) {
      if (desk.live) {
        void this.end(slot, `No worktree: ${(error as Error).message}`);
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
        slot.activity = fitJsonBytes(this.host.redactor.redactText(activity), MAX_TITLE_LENGTH);
      }
    };
    const books = { ledger: this.host.ledger, debug: this.host.debug, on: `${slot.id} at ${desk.requestedBy}'s desk`, slotId: slot.id };
    const reporter = runReporter(slot.screen, desk, books, {
      started: () => report(RUNNER_SLOT_STATUS.idle, ""),
      progress: (activity) => report(RUNNER_SLOT_STATUS.working, activity),
      needsInput: (reason) => {
        report(RUNNER_SLOT_STATUS.needsInput, reason);
        if (desk.live) {
          this.host.log(`${slot.id} at ${desk.requestedBy}'s desk needs a person: ${slot.activity}`);
        }
      },
      turnDone: () => report(RUNNER_SLOT_STATUS.idle, TURN_DONE),
      // Nothing to hand in: a pull request it opens at its player's word is on GitHub for them to see.
      prOpened: (pr) => {
        if (desk.live) {
          this.host.log(`${slot.id} at ${desk.requestedBy}'s desk opened ${pr.simulated === true ? "a simulated pull request" : pr.url}`);
        }
      },
      failed: (message) => {
        if (desk.live) {
          void this.end(slot, message);
        }
      },
      exited: (message) => {
        if (desk.live) {
          void this.end(slot, message);
        }
      },
    });
    const session: AgentSession = { requestedBy: desk.requestedBy, workdir, systemPrompt: systemPrompt(slot.profile) };
    let agentRun: AgentRun;
    try {
      agentRun = startSession.call(this.host.agent, session, reporter);
    } catch (error) {
      void this.end(slot, `The agent did not start: ${(error as Error).message}`);
      return;
    }
    const started = agentRun.process;
    this.host.log(
      started === undefined
        ? `${slot.id} at ${desk.requestedBy}'s desk: the ${this.host.agent.label} agent runs inside the runner`
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

  /** Sizes the desk session's terminal, and its agent's, to its player's panel. */
  public resize(slot: Slot, command: DeskResizeCommand): void {
    const desk = slot.desk;
    if (desk?.seatId !== command.seatId) {
      this.host.debug(`desk-resize for ${slot.id} at ${command.seatId} ignored: it is not lent to that desk`);
      return;
    }
    desk.cols = command.cols;
    desk.rows = command.rows;
    slot.screen.resize(command.cols, command.rows);
    desk.agentRun.resize?.(command.cols, command.rows);
  }

  /**
   * A prompt its player typed at the desk: given only while its agent waits at
   * its prompt, and reported either way. A standup's direction is not kept for
   * a desk session, since its player is the one at its desk.
   */
  public prompt(slot: Slot, desk: DeskOnSlot, command: PromptCommand): void {
    const outcome = this.promptable(slot, desk);
    if (outcome === RUNNER_PROMPT_OUTCOME.delivered) {
      this.host.log(`${slot.id} at ${desk.requestedBy}'s desk prompted by ${command.requestedBy}`);
      slot.status = RUNNER_SLOT_STATUS.working;
      slot.activity = fitJsonBytes(this.host.redactor.redactText(command.text.split("\n")[0] ?? ""), MAX_TITLE_LENGTH);
      desk.agentRun.prompt?.(command.text);
    } else {
      this.host.log(`prompt for ${slot.id} at ${desk.requestedBy}'s desk from ${command.requestedBy} not typed: ${outcome}`);
    }
    this.host.reportOutcome(slot, command.id, outcome);
  }

  /** Whether the desk session's agent waits at its prompt, and if not, why; as a task's is, in `./slotRuns.ts`. */
  private promptable(slot: Slot, desk: DeskOnSlot): RunnerPromptOutcomeKind {
    return promptOutcome(slot.status, desk.live ? desk.agentRun : undefined);
  }

  /** A key its player pressed at the desk: pressed only while its agent waits on a person, and reported either way. */
  public key(slot: Slot, desk: DeskOnSlot, command: KeyCommand): void {
    const label = AGENT_KEY_LABEL[command.key];
    const outcome = keyOutcome(slot.status, desk.live ? desk.agentRun : undefined);
    if (outcome === RUNNER_PROMPT_OUTCOME.delivered) {
      this.host.log(`${slot.id} at ${desk.requestedBy}'s desk: ${command.requestedBy} pressed ${label}`);
      desk.agentRun.key?.(command.key);
    } else {
      this.host.log(`key ${label} for ${slot.id} at ${desk.requestedBy}'s desk not pressed: ${outcome}`);
    }
    this.host.reportOutcome(slot, command.id, outcome);
  }

  /** Ends the slot's desk session at the server's word, if it is lent to that desk. */
  public close(slot: Slot, command: DeskCloseCommand): void {
    if (slot.desk?.seatId !== command.seatId) {
      this.host.debug(`desk-close for ${slot.id} at ${command.seatId} ignored: it is not lent to that desk`);
      return;
    }
    this.host.log(`${slot.id}'s desk session for ${slot.desk.requestedBy} closed: ${command.reason || "the server asked"}`);
    void this.end(slot, undefined);
  }

  /**
   * Ends the slot's desk session, stopping its agent and discarding its
   * worktree once it has exited, and leaves the slot idle. `message` says why
   * when the server did not ask for it, as a `desk-ended` event; `undefined`
   * when it did. Resolves once the worktree is discarded.
   */
  public end(slot: Slot, message: string | undefined): Promise<void> {
    const desk = slot.desk;
    if (desk === undefined) {
      return Promise.resolve();
    }
    desk.live = false;
    const stopped = desk.agentRun.stop();
    slot.desk = undefined;
    slot.status = RUNNER_SLOT_STATUS.idle;
    slot.activity = "";
    // Issue work is run at the runner's own size, whatever its player's panel was.
    slot.screen.resize(SCREEN_COLS, SCREEN_ROWS);
    if (message !== undefined) {
      this.emit(slot, desk.seatId, message);
      this.host.log(`${slot.id}'s desk session for ${desk.requestedBy} ended: ${this.host.redactor.redactText(message)}`);
    }
    this.host.log(`${slot.id} is back from ${desk.requestedBy}'s desk (${formatUsd(desk.spentUsd)} spent)`);
    const { workdir } = desk;
    return workdir === undefined ? stopped : stopped.then(() => this.host.desks?.close(workdir));
  }

  private emit(slot: Slot, seatId: string, message: string): void {
    this.host.events.push({
      id: this.host.eventId(),
      kind: RUNNER_EVENT_KIND.deskEnded,
      slotId: slot.id,
      seatId,
      message: fitJsonBytes(this.host.redactor.redactText(message), MAX_WORK_NOTE_LENGTH),
    });
  }
}
