/**
 * The desk terminals, on the server: which desks' computers each player has
 * on, which runner's slot is lent to each, and how each session stands.
 *
 * Sitting is all it takes. While a player sits at a desk with a computer
 * (`deskTerminalSeat` in `@sim/shared`), this lends the desk the first free
 * runner's slot, one idle with no issue, standing run or desk, and no work in
 * the office waiting for it, with a `desk-open` command; the runner starts a
 * fresh session of its agent there, and the slot's screen becomes the desk's.
 * The player prompts it, and presses keys on it, as the CEO prompts any coding
 * agent, through `./agentPrompts.ts`, so the same budgets hold; the gate lets
 * that player alone through for it (`deskOwnerOf`). Standing up leaves the
 * computer on: the session keeps running, its terminal still on the desk's
 * monitor, and the player sitting at that desk again is back at the same
 * session; anyone else sitting there gets nothing. Each desk is its own
 * session, so a player may sit at another computer and turn that one on too,
 * as many as there are free slots; with none free, that desk waits for one and
 * says so. A session is closed with `desk-close`, and the slot is back on the
 * floor for issue work, only when the player who turned it on turns it off or
 * leaves for good, so a session is never left running that nobody may turn
 * off. A sitting with no
 * slot lent (every agent busy, no runner, or the session ended) leaves nothing
 * running, and standing up forgets it. The player's panel says how many cells it has
 * room for, and the session's terminal is sized to that with `desk-resize`, so
 * its agent wraps its output to the width they read it at.
 *
 * It is declarative, as the work's reconciliation is (`./runnerWork.ts`): each
 * step compares where the players sit, and which desks are on, with what the runners report, and sends
 * only what closes the gap. A slot reporting a desk no room has lent it to,
 * as after the server restarted, is closed too. Every room's
 * terminal shares the one runner link, so which slot is lent to which desk is
 * kept per link, not per room: no room lends, or closes, another's slot.
 *
 * Every player may be lent a slot (`deskTerminalRefusal`), though what its
 * agent runs, it runs on the runner's host.
 *
 * What it decides is written to the replicated `desks`, one `DeskTerminal` per
 * desk that is on, which every tab reads to draw each session's terminal on its
 * desk's monitor, and its player's tab to open the panel at the desk they sit at. Synchronous, and run on the tick: it reads what the
 * runner link already holds and never waits on a runner.
 */

import {
  DESK_TERMINAL_PHASE,
  DeskTerminal as DeskTerminalState,
  type DeskTerminalPhase,
  type OfficeLayout,
  type OfficeState,
  RUNNER_COMMAND_KIND,
  RUNNER_EVENT_KIND,
  RUNNER_SLOT_STATUS,
  type RunnerCommand,
  type RunnerCommandDraft,
  WORK_STATUS,
  brainstormHeld,
  actorOf,
  deskTerminalRefusal,
  deskTerminalSeat,
  isHumanPlayer,
  liveAgentKey,
} from "@sim/shared";

import type { RunnerDeskSlot, RunnerEventRecord, RunnerSlotRef } from "./runnerLink.js";
import { runnerSlotAgentId } from "./runnerLink.js";
import { slotOf } from "./runnerWork.js";

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

/** One desk's computer while it is on, whose it is, and the slot lent to it. */
interface Session {
  readonly seatId: string;
  readonly ownerId: string;
  readonly ownerName: string;
  /** The slot lent to it; `undefined` until one is. */
  lent: RunnerSlotRef | undefined;
  /** The slot has reported the desk since it was lent. */
  opened: boolean;
  /** Why it ended without its player turning it off, once it has; nothing more is lent this sitting. */
  ended: string | undefined;
  /** The cells its player's panel has room for, once it has said. */
  size: TerminalSize | undefined;
  /** The size last sent to the lent slot, cleared whenever another is lent. */
  sentSize: TerminalSize | undefined;
}

interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

/** A player, and the desk with a computer they sit at, if any. */
interface Player {
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
  /** Every desk whose computer is on, by seat id. */
  private readonly sessions = new Map<string, Session>();
  /** Slots reporting a desk this room has asked to close, by `runner:slot@seat`, until they stop reporting it. */
  private readonly closing = new Set<string>();
  /** The seat each player turned the computer off at while sitting there, by player, so it stays off until they stand up. */
  private readonly turnedOffAt = new Map<string, string>();

  public constructor(private readonly options: DeskTerminalOptions) {}

  /** Gives every session's slot back, as the room closes. */
  public dispose(): void {
    for (const session of [...this.sessions.values()]) {
      this.close(session, "the room closed");
    }
  }

  /**
   * One step: closes every session once its player is gone, and any its player
   * has stood up from with nothing running; lends one to each player sitting
   * at a desk whose computer is off; and writes where each stands to the state.
   */
  public step(): void {
    const players = this.players();
    for (const [ownerId, seatId] of this.turnedOffAt) {
      if (players.get(ownerId)?.seatId !== seatId) {
        this.turnedOffAt.delete(ownerId);
      }
    }
    for (const session of [...this.sessions.values()]) {
      const owner = players.get(session.ownerId);
      if (owner === undefined) {
        this.close(session, "its player left");
      } else if (owner.seatId !== session.seatId && session.lent === undefined) {
        this.close(session, "its player stood up");
      }
    }
    for (const player of players.values()) {
      if (player.seatId !== undefined && player.seatId !== this.turnedOffAt.get(player.id) && !this.sessions.has(player.seatId)) {
        this.sessions.set(player.seatId, { seatId: player.seatId, ownerId: player.id, ownerName: player.name, lent: undefined, opened: false, ended: undefined, size: undefined, sentSize: undefined });
        this.options.log?.("desk-terminal-sat", { seat: player.seatId, by: player.name });
      }
    }
    const slots = this.options.runner?.hasRunners() === true ? this.options.runner.deskSlots() : [];
    for (const session of this.sessions.values()) {
      this.advance(session, slots, players.get(session.ownerId)?.seatId === session.seatId);
      this.sendSize(session);
    }
    this.closeStrays(slots);
    this.publish(slots);
  }

  /**
   * Takes the cells a player's panel has room for, from that player sitting at
   * one of their desks; the next step sizes that desk's terminal to them.
   */
  public resize(ownerId: string, cols: number, rows: number): void {
    const seatId = this.players().get(ownerId)?.seatId;
    const session = seatId === undefined ? undefined : this.sessions.get(seatId);
    if (session?.ownerId === ownerId) {
      session.size = { cols, rows };
    }
  }

  /**
   * The player whose desk the agent `agentId` is lent to, for the prompt gate:
   * `undefined` while it is lent to no desk, and `""`, nobody here, while a
   * desk in another room on the same runner link holds it, or one closed here
   * still reports it.
   */
  public deskOwnerOf(agentId: string): string | undefined {
    const slot = slotOf(agentId);
    if (slot === undefined) {
      return undefined;
    }
    if (this.lentSlots()?.has(slotKey(slot)) !== true) {
      const closing = `${slotKey(slot)}@`;
      return [...this.closing].some((key) => key.startsWith(closing)) ? "" : undefined;
    }
    for (const session of this.sessions.values()) {
      if (session.lent !== undefined && sameSlot(session.lent, slot)) {
        return session.ownerId;
      }
    }
    return "";
  }

  /**
   * Turns one desk's computer off for the player who turned it on: closes that
   * desk's session alone, whether they sit there or not, and lends nothing
   * more at that desk until they have stood up from it.
   */
  public turnOff(ownerId: string, seatId: string): void {
    const session = this.sessions.get(seatId);
    if (session?.ownerId !== ownerId) {
      return;
    }
    this.close(session, "its player turned it off");
    this.turnedOffAt.set(ownerId, session.seatId);
  }

  /** Ends the session the runner says ended, or never started, with its reason. */
  public receive(events: readonly RunnerEventRecord[]): void {
    for (const { runnerId, event } of events) {
      if (event.kind !== RUNNER_EVENT_KIND.deskEnded) {
        continue;
      }
      const session = this.sessions.get(event.seatId);
      const lent = session?.lent;
      if (session === undefined || lent === undefined || !sameSlot(lent, { runnerId, slotId: event.slotId })) {
        continue;
      }
      this.lend(session, undefined);
      session.ended = event.message === "" ? DESK_SESSION_GONE : event.message;
      this.options.log?.("desk-terminal-ended", { seat: session.seatId, agent: event.slotId, why: session.ended });
    }
  }

  /** Every player who may use a desk's computer, by id, with the desk with a computer they sit at, if any. */
  private players(): Map<string, Player> {
    const players = new Map<string, Player>();
    for (const occupant of this.options.state.occupants.values()) {
      if (!isHumanPlayer(occupant) || deskTerminalRefusal(actorOf(occupant)) !== undefined) {
        continue;
      }
      players.set(occupant.id, { id: occupant.id, name: occupant.name, seatId: deskTerminalSeat(this.options.layout, occupant.interactableId)?.id });
    }
    return players;
  }

  /**
   * Follows the lent slot, or lends one; a fresh slot only while its player sits
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

  /** Sizes the lent slot's terminal to its player's panel, when that is news to it. */
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
    // An idea's research or meeting holds its agents as an issue does.
    return brainstormHeld(agentId, this.options.state.brainstorms.values()) !== undefined;
  }

  /** Gives the session's slot back, if it has one, and forgets the session. */
  private close(session: Session, reason: string): void {
    this.sessions.delete(session.seatId);
    this.options.log?.("desk-terminal-closed", { seat: session.seatId, by: session.ownerName, why: reason });
    const lent = session.lent;
    if (lent !== undefined) {
      this.lend(session, undefined);
      this.sendClose(lent, session.seatId, reason);
    }
  }

  private sendClose(slot: RunnerSlotRef, seatId: string, reason: string): void {
    this.closing.add(`${slotKey(slot)}@${seatId}`);
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

  /**
   * Writes where each session stands to the replicated state, one record per
   * desk that is on, field by field, so a step that changed nothing sends nothing.
   */
  private publish(slots: readonly RunnerDeskSlot[]): void {
    const desks = this.options.state.desks;
    for (const seatId of [...desks.keys()]) {
      if (!this.sessions.has(seatId)) {
        desks.delete(seatId);
      }
    }
    for (const session of this.sessions.values()) {
      let desk = desks.get(session.seatId);
      if (desk === undefined) {
        desk = new DeskTerminalState();
        desk.seatId = session.seatId;
        desks.set(session.seatId, desk);
      }
      const lent = session.lent;
      const slot = lent === undefined || !session.opened ? undefined : slots.find((candidate) => sameSlot(candidate, lent));
      desk.ownerId = session.ownerId;
      desk.agentId = slot === undefined ? "" : liveAgentKey(runnerSlotAgentId(slot.runnerId, slot.slotId));
      desk.phase = this.phaseOf(session, slot);
      desk.needsInput = slot?.status === RUNNER_SLOT_STATUS.needsInput;
      desk.activity = slot?.activity ?? "";
      desk.note = session.ended ?? "";
    }
  }

  private phaseOf(session: Session, slot: RunnerDeskSlot | undefined): DeskTerminalPhase {
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
