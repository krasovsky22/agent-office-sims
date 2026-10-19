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
 * hold. The moment the CEO is no longer sitting there (stood up, left, or
 * handed the role on), the session is closed with `desk-close`, and the slot
 * is back on the floor for issue work. Nothing persists between sittings: the
 * next one lends a fresh session.
 *
 * It is declarative, as the work's reconciliation is (`./runnerWork.ts`): each
 * step compares where the CEO sits with what the runners report, and sends
 * only what closes the gap. A slot reporting a desk this room has no session
 * for, as after the room was closed and opened again, is closed too.
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

/** Whether a room option is the runner link, as far as the desk terminal needs it. */
export function isDeskRunner(value: unknown): value is DeskRunner {
  const candidate = value as Partial<Record<keyof DeskRunner, unknown>> | null;
  return (
    typeof value === "object" &&
    candidate !== null &&
    typeof candidate.enqueue === "function" &&
    typeof candidate.hasRunners === "function" &&
    typeof candidate.deskSlots === "function"
  );
}

/** Why a session ended that the runner says ended without saying why. */
export const DESK_SESSION_GONE = "The session ended.";

export interface DeskTerminalOptions {
  readonly state: OfficeState;
  readonly layout: OfficeLayout;
  /** Absent when the server has no runner link at all. */
  readonly runner: DeskRunner | undefined;
  readonly log?: (name: string, detail: Record<string, string | number>) => void;
}

/** The CEO's sitting, and the slot lent to it. */
interface Session {
  readonly seatId: string;
  readonly ownerId: string;
  readonly ownerName: string;
  /** The slot lent to it; `undefined` until one is. */
  lent: RunnerSlotRef | undefined;
  /** The slot has reported the desk since it was lent. */
  opened: boolean;
  /** Why it ended without the CEO standing up, once it has; nothing more is lent this sitting. */
  ended: string | undefined;
}

/** Where the CEO sits, if at a desk with a computer. */
interface Sitting {
  readonly seatId: string;
  readonly ownerId: string;
  readonly ownerName: string;
}

function sameSlot(a: RunnerSlotRef, b: RunnerSlotRef): boolean {
  return a.runnerId === b.runnerId && a.slotId === b.slotId;
}

export class DeskTerminal {
  private session: Session | undefined;
  /** Slots reporting a desk this room has asked to close, by `runner:slot@seat`, until they stop reporting it. */
  private readonly closing = new Set<string>();

  public constructor(private readonly options: DeskTerminalOptions) {}

  /**
   * One step: closes the session if the CEO has left the desk, lends one if
   * the CEO sits at a desk without, and writes where it stands to the state.
   */
  public step(): void {
    const sitting = this.sitting();
    let session = this.session;
    if (session !== undefined && (sitting === undefined || sitting.seatId !== session.seatId || sitting.ownerId !== session.ownerId)) {
      this.close(session, sitting === undefined ? "the CEO stood up" : "the CEO moved on");
      session = undefined;
    }
    if (session === undefined && sitting !== undefined) {
      session = { ...sitting, lent: undefined, opened: false, ended: undefined };
      this.session = session;
      this.options.log?.("desk-terminal-sat", { seat: sitting.seatId, by: sitting.ownerName });
    }
    const slots = this.options.runner?.hasRunners() === true ? this.options.runner.deskSlots() : [];
    if (session !== undefined) {
      this.advance(session, slots);
    }
    this.closeStrays(slots);
    this.publish(session, slots);
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
      session.lent = undefined;
      session.ended = event.message === "" ? DESK_SESSION_GONE : event.message;
      this.options.log?.("desk-terminal-ended", { seat: session.seatId, agent: event.slotId, why: session.ended });
    }
  }

  /** The CEO, if sitting at a desk with a computer. */
  private sitting(): Sitting | undefined {
    for (const occupant of this.options.state.occupants.values()) {
      if (!isHumanPlayer(occupant) || deskTerminalRefusal(actorOf(occupant)) !== undefined) {
        continue;
      }
      const seat = deskTerminalSeat(this.options.layout, occupant.interactableId);
      return seat === undefined ? undefined : { seatId: seat.id, ownerId: occupant.id, ownerName: occupant.name };
    }
    return undefined;
  }

  /** Follows the lent slot, or lends one. */
  private advance(session: Session, slots: readonly RunnerDeskSlot[]): void {
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
        session.lent = undefined;
        session.ended = DESK_SESSION_GONE;
        return;
      }
      // Its runner went silent, and took the slot with it: lend another.
      session.lent = undefined;
      session.opened = false;
    }
    const free = slots.find((slot) => slot.free && !this.hasWork(slot));
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
    session.lent = { runnerId: free.runnerId, slotId: free.slotId };
    this.options.log?.("desk-terminal-lent", { seat: session.seatId, agent: free.slotId, by: session.ownerName });
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
    if (session.lent !== undefined) {
      this.sendClose(session.lent, session.seatId, reason);
    }
  }

  private sendClose(slot: RunnerSlotRef, seatId: string, reason: string): void {
    this.closing.add(`${slot.runnerId}:${slot.slotId}@${seatId}`);
    this.options.runner?.enqueue(slot.runnerId, { kind: RUNNER_COMMAND_KIND.deskClose, slotId: slot.slotId, seatId, reason });
  }

  /** Closes, once each, every slot reporting a desk that is not this session's. */
  private closeStrays(slots: readonly RunnerDeskSlot[]): void {
    const reporting = new Set<string>();
    for (const slot of slots) {
      if (slot.seatId === undefined) {
        continue;
      }
      const key = `${slot.runnerId}:${slot.slotId}@${slot.seatId}`;
      reporting.add(key);
      const lent = this.session?.lent;
      if ((lent !== undefined && sameSlot(lent, slot) && slot.seatId === this.session?.seatId) || this.closing.has(key)) {
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
    if (desk.seatId !== (session?.seatId ?? "")) {
      desk.seatId = session?.seatId ?? "";
    }
    if (desk.ownerId !== (session?.ownerId ?? "")) {
      desk.ownerId = session?.ownerId ?? "";
    }
    if (desk.agentId !== agentId) {
      desk.agentId = agentId;
    }
    if (desk.phase !== phase) {
      desk.phase = phase;
    }
    if (desk.needsInput !== needsInput) {
      desk.needsInput = needsInput;
    }
    if (desk.activity !== activity) {
      desk.activity = activity;
    }
    if (desk.note !== note) {
      desk.note = note;
    }
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
