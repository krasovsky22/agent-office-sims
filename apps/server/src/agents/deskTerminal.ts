/**
 * The CEO's desk terminal, on the server: which desk the CEO sits at, which
 * runner's slot is lent to it, and how its session stands.
 *
 * Sitting is all it takes. While the CEO sits at a desk with a computer
 * (`deskTerminalSeat` in `@sim/shared`), this lends the desk the first free
 * runner's slot, one idle with no issue, standing run or desk, and no work in
 * the office waiting for it, with a `desk-open` command; the runner starts a
 * fresh session of its agent there, and the slot's screen becomes the desk's.
 * The CEO prompts it, and presses keys on it, as the CEO prompts any coding
 * agent, through `./agentPrompts.ts`, so the same gate and the same budgets
 * hold. Standing up leaves the computer on: the session keeps running, its
 * terminal still on the desk's monitor, and the CEO sitting at that desk again
 * is back at the same session. It is closed with `desk-close`, and the slot is
 * back on the floor for issue work, only when the CEO turns it off, or is no
 * longer the CEO who turned it on (left for good, or handed the role on), so a
 * session is never left running that nobody may turn off. A sitting with no
 * slot lent (every agent busy, no runner, or the session ended) leaves nothing
 * running, and standing up forgets it. The CEO's panel says how many cells it has
 * room for, and the session's terminal is sized to that with `desk-resize`, so
 * its agent wraps its output to the width the CEO reads it at.
 *
 * It is declarative, as the work's reconciliation is (`./runnerWork.ts`): each
 * step compares where the CEO sits with what the runners report, and sends
 * only what closes the gap. A slot reporting a desk no room has lent it to,
 * as after the server restarted, is closed too. Every room's
 * terminal shares the one runner link, so which slot is lent to which desk is
 * kept per link, not per room: no room lends, or closes, another's slot.
 *
 * Only the CEO is ever lent a slot, since what its agent runs, it runs on the
 * runner's host: the rule is `deskTerminalRefusal`, the prompt gate. Anyone
 * else sitting at a desk gets nothing from here.
 *
 * What it decides is written to the replicated `DeskTerminal`, which every tab
 * reads to draw the session's terminal on that desk's monitor, and the CEO's
 * tab to open the panel. Synchronous, and run on the tick: it reads what the
 * runner link already holds and never waits on a runner.
 */

import {
  DESK_TERMINAL_PHASE,
  type DeskTerminalPhase,
  type OfficeLayout,
  type OfficeState,
  RUNNER_COMMAND_KIND,
  RUNNER_EVENT_KIND,
  RUNNER_SLOT_STATUS,
  type RunnerCommand,
  type RunnerCommandDraft,
  WORK_STATUS,
  actorOf,
  deskTerminalRefusal,
  deskTerminalSeat,
  isHumanPlayer,
  liveAgentKey,
} from "@sim/shared";

import type { RunnerDeskSlot, RunnerEventRecord, RunnerSlotRef } from "./runnerLink.js";
import { runnerSlotAgentId } from "./runnerLink.js";

/** What the desk terminal needs of the runner link. */
export interface DeskRunner {
  /** Queues a command for a slot; `undefined` when the runner cannot be given it. */
  enqueue(runnerId: string, draft: RunnerCommandDraft): RunnerCommand | undefined;
  /** Whether any runner is connected. */
  hasRunners(): boolean;
  /** Every runner's slots, at their last sync. */
  deskSlots(): readonly RunnerDeskSlot[];
}

/** Why a session ended that the runner says ended without saying why. */
const DESK_SESSION_GONE = "The session ended.";

export interface DeskTerminalOptions {
  readonly state: OfficeState;
  readonly layout: OfficeLayout;
  /** Absent when the server has no runner link at all. */
  readonly runner: DeskRunner | undefined;
  readonly log?: (name: string, detail: Record<string, string | number>) => void;
}

/** The CEO's desk's computer while it is on, and the slot lent to it. */
interface Session {
  readonly seatId: string;
  readonly ownerId: string;
  readonly ownerName: string;
  /** The slot lent to it; `undefined` until one is. */
  lent: RunnerSlotRef | undefined;
  /** The slot has reported the desk since it was lent. */
  opened: boolean;
  /** Why it ended without the CEO turning it off, once it has; nothing more is lent this sitting. */
  ended: string | undefined;
  /** The cells the CEO's panel has room for, once it has said. */
  size: TerminalSize | undefined;
  /** The size last sent to the lent slot, cleared whenever another is lent. */
  sentSize: TerminalSize | undefined;
}

interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

/** The CEO, and the desk with a computer they sit at, if any. */
interface Ceo {
  readonly id: string;
  readonly name: string;
  readonly seatId: string | undefined;
}

/** Every slot lent to a desk, by `runner:slot`, to its seat, per runner link, across rooms. */
const lentByRunner = new WeakMap<DeskRunner, Map<string, string>>();

function slotKey(slot: RunnerSlotRef): string {
  return `${slot.runnerId}:${slot.slotId}`;
}

function sameSlot(a: RunnerSlotRef, b: RunnerSlotRef): boolean {
  return a.runnerId === b.runnerId && a.slotId === b.slotId;
}

export class DeskTerminal {
  private session: Session | undefined;
  /** Slots reporting a desk this room has asked to close, by `runner:slot@seat`, until they stop reporting it. */
  private readonly closing = new Set<string>();
  /** The seat the CEO turned the computer off at while sitting there, so it stays off until they stand up. */
  private turnedOffAt: string | undefined;

  public constructor(private readonly options: DeskTerminalOptions) {}

  /** Gives the session's slot back, as the room closes. */
  public dispose(): void {
    if (this.session !== undefined) {
      this.close(this.session, "the room closed");
    }
  }

  /**
   * One step: closes the session once its CEO is gone, or once the CEO has
   * stood up from one with nothing running; lends one if the CEO sits at a
   * desk while the computer is off; and writes where it stands to the state.
   */
  public step(): void {
    const ceo = this.ceo();
    if (this.turnedOffAt !== undefined && ceo?.seatId !== this.turnedOffAt) {
      this.turnedOffAt = undefined;
    }
    let session = this.session;
    if (session !== undefined && ceo?.id !== session.ownerId) {
      this.close(session, ceo === undefined ? "the CEO left" : "the CEO handed the role on");
      session = undefined;
    }
    const sitting = session !== undefined && ceo?.seatId === session.seatId;
    if (session !== undefined && !sitting && session.lent === undefined) {
      this.close(session, "the CEO stood up");
      session = undefined;
    }
    if (session === undefined && ceo?.seatId !== undefined && ceo.seatId !== this.turnedOffAt) {
      session = { seatId: ceo.seatId, ownerId: ceo.id, ownerName: ceo.name, lent: undefined, opened: false, ended: undefined, size: undefined, sentSize: undefined };
      this.session = session;
      this.options.log?.("desk-terminal-sat", { seat: ceo.seatId, by: ceo.name });
    }
    const slots = this.options.runner?.hasRunners() === true ? this.options.runner.deskSlots() : [];
    if (session !== undefined) {
      this.advance(session, slots, ceo?.seatId === session.seatId);
      this.sendSize(session);
    }
    this.closeStrays(slots);
    this.publish(session, slots);
  }

  /**
   * Takes the cells the CEO's panel has room for, from the CEO sitting there;
   * the next step sizes the session's terminal to them.
   */
  public resize(ownerId: string, cols: number, rows: number): void {
    const session = this.session;
    if (session?.ownerId === ownerId) {
      session.size = { cols, rows };
    }
  }

  /**
   * Turns the computer off for the CEO who turned it on: closes its session,
   * whether they sit there or not, and lends nothing more at that desk until
   * they have stood up from it.
   */
  public turnOff(ownerId: string): void {
    const session = this.session;
    if (session?.ownerId !== ownerId) {
      return;
    }
    this.close(session, "the CEO turned it off");
    this.turnedOffAt = session.seatId;
  }

  /** Ends the session the runner says ended, or never started, with its reason. */
  public receive(events: readonly RunnerEventRecord[]): void {
    const session = this.session;
    for (const { runnerId, event } of events) {
      if (event.kind !== RUNNER_EVENT_KIND.deskEnded) {
        continue;
      }
      const lent = session?.lent;
      if (session === undefined || lent === undefined || !sameSlot(lent, { runnerId, slotId: event.slotId }) || event.seatId !== session.seatId) {
        continue;
      }
      this.lend(session, undefined);
      session.ended = event.message === "" ? DESK_SESSION_GONE : event.message;
      this.options.log?.("desk-terminal-ended", { seat: session.seatId, agent: event.slotId, why: session.ended });
    }
  }

  /** The CEO, with the desk with a computer they sit at, if any. */
  private ceo(): Ceo | undefined {
    for (const occupant of this.options.state.occupants.values()) {
      if (!isHumanPlayer(occupant) || deskTerminalRefusal(actorOf(occupant)) !== undefined) {
        continue;
      }
      return { id: occupant.id, name: occupant.name, seatId: deskTerminalSeat(this.options.layout, occupant.interactableId)?.id };
    }
    return undefined;
  }

  /**
   * Follows the lent slot, or lends one; a fresh slot only while the CEO sits
   * there, since one lent to an empty chair would only be forgotten.
   */
  private advance(session: Session, slots: readonly RunnerDeskSlot[], sitting: boolean): void {
    if (session.ended !== undefined) {
      return;
    }
    const lent = session.lent;
    if (lent !== undefined) {
      const slot = slots.find((candidate) => sameSlot(candidate, lent));
      if (slot?.seatId === session.seatId) {
        session.opened = true;
        return;
      }
      if (slot !== undefined && !session.opened) {
        // The runner has not taken the command yet.
        return;
      }
      if (slot !== undefined) {
        // It said nothing of why; its event, if one comes, is no longer news.
        this.lend(session, undefined);
        session.ended = DESK_SESSION_GONE;
        return;
      }
      // Its runner went silent, and took the slot with it: lend another.
      this.lend(session, undefined);
      session.opened = false;
    }
    if (!sitting) {
      return;
    }
    const lentSlots = this.lentSlots();
    const free = slots.find((slot) => slot.free && lentSlots?.has(slotKey(slot)) !== true && !this.hasWork(slot));
    if (free === undefined) {
      return;
    }
    const command = this.options.runner?.enqueue(free.runnerId, {
      kind: RUNNER_COMMAND_KIND.deskOpen,
      slotId: free.slotId,
      seatId: session.seatId,
      requestedBy: session.ownerName,
    });
    if (command === undefined) {
      return;
    }
    this.lend(session, { runnerId: free.runnerId, slotId: free.slotId });
    this.options.log?.("desk-terminal-lent", { seat: session.seatId, agent: free.slotId, by: session.ownerName });
  }

  /** Sizes the lent slot's terminal to the CEO's panel, when that is news to it. */
  private sendSize(session: Session): void {
    const { lent, size, sentSize } = session;
    if (lent === undefined || size === undefined || (sentSize?.cols === size.cols && sentSize.rows === size.rows)) {
      return;
    }
    const command = this.options.runner?.enqueue(lent.runnerId, {
      kind: RUNNER_COMMAND_KIND.deskResize,
      slotId: lent.slotId,
      seatId: session.seatId,
      cols: size.cols,
      rows: size.rows,
    });
    if (command !== undefined) {
      session.sentSize = size;
    }
  }

  /** The slots lent to a desk by any room on this runner link. */
  private lentSlots(): Map<string, string> | undefined {
    const runner = this.options.runner;
    if (runner === undefined) {
      return undefined;
    }
    let lent = lentByRunner.get(runner);
    if (lent === undefined) {
      lent = new Map();
      lentByRunner.set(runner, lent);
    }
    return lent;
  }

  /** Lends the session a slot, or takes it back, in the session and in the link-wide record. */
  private lend(session: Session, slot: RunnerSlotRef | undefined): void {
    const lentSlots = this.lentSlots();
    if (session.lent !== undefined) {
      lentSlots?.delete(slotKey(session.lent));
    }
    session.lent = slot;
    session.sentSize = undefined;
    if (slot !== undefined) {
      lentSlots?.set(slotKey(slot), session.seatId);
    }
  }

  /** Whether the office has work for the slot's agent that it has not started on yet, so it is not free after all. */
  private hasWork(slot: RunnerSlotRef): boolean {
    const agentId = liveAgentKey(runnerSlotAgentId(slot.runnerId, slot.slotId));
    for (const work of this.options.state.work.values()) {
      if (work.assigneeId === agentId && work.status !== WORK_STATUS.done) {
        return true;
      }
    }
    return false;
  }

  /** Gives the session's slot back, if it has one, and forgets the session. */
  private close(session: Session, reason: string): void {
    this.session = undefined;
    this.options.log?.("desk-terminal-closed", { seat: session.seatId, by: session.ownerName, why: reason });
    const lent = session.lent;
    if (lent !== undefined) {
      this.lend(session, undefined);
      this.sendClose(lent, session.seatId, reason);
    }
  }

  private sendClose(slot: RunnerSlotRef, seatId: string, reason: string): void {
    this.closing.add(`${slot.runnerId}:${slot.slotId}@${seatId}`);
    this.options.runner?.enqueue(slot.runnerId, { kind: RUNNER_COMMAND_KIND.deskClose, slotId: slot.slotId, seatId, reason });
  }

  /** Closes, once each, every slot reporting a desk no room has lent it to. */
  private closeStrays(slots: readonly RunnerDeskSlot[]): void {
    const lentSlots = this.lentSlots();
    const reporting = new Set<string>();
    for (const slot of slots) {
      if (slot.seatId === undefined) {
        continue;
      }
      const key = `${slot.runnerId}:${slot.slotId}@${slot.seatId}`;
      reporting.add(key);
      if (lentSlots?.get(slotKey(slot)) === slot.seatId || this.closing.has(key)) {
        continue;
      }
      this.sendClose(slot, slot.seatId, "nobody sits at that desk");
    }
    for (const key of this.closing) {
      if (!reporting.has(key)) {
        this.closing.delete(key);
      }
    }
  }

  /** Writes where the session stands to the replicated state, field by field, so a step that changed nothing sends nothing. */
  private publish(session: Session | undefined, slots: readonly RunnerDeskSlot[]): void {
    const desk = this.options.state.desk;
    const lent = session?.lent;
    const slot = lent === undefined || session?.opened !== true ? undefined : slots.find((candidate) => sameSlot(candidate, lent));
    const phase = this.phaseOf(session, slot);
    const agentId = slot === undefined ? "" : liveAgentKey(runnerSlotAgentId(slot.runnerId, slot.slotId));
    const needsInput = slot?.status === RUNNER_SLOT_STATUS.needsInput;
    const activity = slot?.activity ?? "";
    const note = session?.ended ?? "";
    desk.seatId = session?.seatId ?? "";
    desk.ownerId = session?.ownerId ?? "";
    desk.agentId = agentId;
    desk.phase = phase;
    desk.needsInput = needsInput;
    desk.activity = activity;
    desk.note = note;
  }

  private phaseOf(session: Session | undefined, slot: RunnerDeskSlot | undefined): DeskTerminalPhase {
    if (session === undefined) {
      return DESK_TERMINAL_PHASE.off;
    }
    if (session.ended !== undefined) {
      return DESK_TERMINAL_PHASE.ended;
    }
    if (slot !== undefined) {
      return DESK_TERMINAL_PHASE.open;
    }
    if (session.lent !== undefined) {
      return DESK_TERMINAL_PHASE.starting;
    }
    return this.options.runner?.hasRunners() === true ? DESK_TERMINAL_PHASE.waiting : DESK_TERMINAL_PHASE.noRunner;
  }
}
