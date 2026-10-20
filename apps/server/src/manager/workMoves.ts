/**
 * Carrying out the work moves in a manager's plan: approving work handed in,
 * sending it back for rework, taking it back, and starting it again, the
 * moves the project board offers on work an agent has.
 *
 * Each is resolved against the live office and made through `applyWorkCommand`
 * as the CEO who asked, exactly as an assignment is (`./assign.ts`), so the
 * work's one gate decides and a move the CEO could not make on the board is
 * not made. The change reaches the agent the way the board's does: through
 * the room's work observer (`../agents/runnerWork.ts`), which gives a
 * send-back's note to the agent with its rework.
 *
 * Nothing is written to GitHub. Synchronous, like an assignment.
 */

import {
  type Occupant,
  WORK_ACTION,
  WORK_REJECTION,
  WORK_STATUS,
  type IssueWork,
  type WorkCommand,
  type WorkRejection,
  type WorkStatus,
  actorOf,
  isWorkStopped,
  workKey,
} from "@sim/shared";

import { type WorkHost, applyAs } from "../rooms/workHandlers.js";
import type { PlannedWorkMove } from "./advisor.js";
import { REFUSAL_TEXT } from "./assign.js";
import type { OfficeView } from "./officeView.js";
import { describeWork, resolveWork } from "./resolve.js";

/** Most moves one plan may make, as for assignments. */
export const MAX_MOVES_PER_PLAN = 10;

export interface WorkMoveContext {
  readonly work: WorkHost;
  /** The CEO the manager is acting for, as the room holds them now. */
  readonly ceo: Occupant;
  /** The office as it stands now. */
  readonly view: OfficeView;
}

/**
 * Makes each move, in order.
 *
 * @returns one line per move saying what happened, for the reply.
 */
export function carryOutMoves(moves: readonly PlannedWorkMove[], context: WorkMoveContext): string[] {
  const lines = moves.slice(0, MAX_MOVES_PER_PLAN).map((move) => carryOutMove(move, context));
  if (moves.length > MAX_MOVES_PER_PLAN) {
    lines.push(`I stopped after ${MAX_MOVES_PER_PLAN} changes; ask again for the rest.`);
  }
  return lines;
}

function carryOutMove(move: PlannedWorkMove, context: WorkMoveContext): string {
  const ref = resolveWork(move.work, context.view);
  if (ref === undefined) {
    return `✗ ${move.work}: I can't find that on the project board.`;
  }
  const label = describeWork(ref);
  if (ref.kind === "pull") {
    return `✗ ${label}: the office's work is on issues, and a pull request has none to change.`;
  }
  const work = context.work.state.work.get(workKey(ref.issue.number));
  if (work === undefined) {
    return `✗ ${label}: ${REFUSAL_TEXT[WORK_REJECTION.noWork]}.`;
  }
  const who = context.work.state.occupants.get(work.assigneeId)?.name ?? "someone who has left";
  const status = work.status;
  // `assigned` -> `in_progress` is a legal move too, but it is not a send-back.
  if (move.move === "send-back" && status !== WORK_STATUS.review) {
    return `✗ ${label}: ${refusal(move, status, WORK_REJECTION.illegalTransition)}.`;
  }
  const result = applyAs(context.work, actorOf(context.ceo), commandFor(move, work));
  if (!result.ok) {
    return `✗ ${label}: ${refusal(move, status, result.rejection)}.`;
  }
  switch (move.move) {
    case "approve":
      return `✓ ${label}: approved; ${who}'s work on it is done.`;
    case "send-back":
      return `✓ ${label}: sent back to ${who} for rework${move.note.trim() === "" ? "" : ", with your note"}.`;
    case "take-back":
      return `✓ ${label}: taken off ${who}; it is free on the board.`;
    case "start-again":
      return `✓ ${label}: ${who} is starting it again from the top.`;
  }
}

/**
 * The command the board would send for the move. Starting again is the
 * card's "Start again" for work that stopped, giving it to the same agent,
 * and otherwise its "Have them start again", back to `assigned`.
 */
function commandFor(move: PlannedWorkMove, work: IssueWork): WorkCommand {
  const issueNumber = work.issueNumber;
  switch (move.move) {
    case "approve":
      return { action: WORK_ACTION.moveStatus, payload: { issueNumber, status: WORK_STATUS.done } };
    case "send-back":
      return { action: WORK_ACTION.moveStatus, payload: { issueNumber, status: WORK_STATUS.in_progress, reworkNote: move.note } };
    case "take-back":
      return { action: WORK_ACTION.release, payload: { issueNumber } };
    case "start-again":
      return isWorkStopped(work)
        ? { action: WORK_ACTION.assign, payload: { issueNumber, assigneeId: work.assigneeId } }
        : { action: WORK_ACTION.moveStatus, payload: { issueNumber, status: WORK_STATUS.assigned } };
  }
}

/** Why the work's rules refused the move, as the manager says it, read from the status the work had. */
function refusal(move: PlannedWorkMove, status: WorkStatus, rejection: WorkRejection): string {
  if (rejection === WORK_REJECTION.forbidden) {
    return "only the CEO can do that";
  }
  if (rejection !== WORK_REJECTION.illegalTransition) {
    return REFUSAL_TEXT[rejection];
  }
  if (status === WORK_STATUS.done) {
    return "it is finished, and finished work keeps who did it";
  }
  switch (move.move) {
    case "approve":
      return "it isn't waiting for your review";
    case "send-back":
      return status === WORK_STATUS.review
        ? "the agent who handed it in has left the office; take it back and hand it to someone else"
        : "it isn't waiting for your review";
    case "take-back":
      return "it is waiting for your review; approve it or send it back instead";
    case "start-again":
      return status === WORK_STATUS.review
        ? "it is waiting for your review; send it back instead"
        : "it hasn't started yet, so there is nothing to start again";
  }
}
