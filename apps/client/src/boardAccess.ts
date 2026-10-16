/**
 * What the local player may do about the project board's work, in words the
 * HUD can show.
 *
 * The decision is not made here. `mayActOnWork` in `@sim/shared` is the rule
 * the server enforces, and this module only asks it the same question about the
 * local player, so a control is disabled exactly when the server would refuse
 * it. Everything a board control needs — whether to offer it, which moves are
 * on offer, and what to say when it is not — comes from this one place, so the
 * board panel has a single import to gate on rather than a role check of its
 * own.
 */

import {
  type OfficeActor,
  WORK_REJECTION,
  type WorkAction,
  type WorkData,
  type WorkMove,
  type WorkRejection,
  mayActOnWork,
  mayAssignWork,
  workMoves,
} from "@sim/shared";

/** The local player's standing at the board. */
export interface BoardAccess {
  /** Whether the board is read-only for this player. */
  readonly readOnly: boolean;
  /** One sentence on what this player may do, and why, for the HUD. */
  readonly summary: string;
  /** Whether the board panel offers to hand an open issue to an agent. */
  readonly mayAssign: boolean;
  /**
   * The moves the board panel offers on `work`, given who is in the office;
   * the shared planner's answer.
   */
  readonly movesFor: (work: WorkData, people: readonly { readonly id: string }[]) => WorkMove[];
}

/** Whether `actor` may perform `action`; the server's own rule. */
export function mayAct(actor: OfficeActor, action: WorkAction): boolean {
  return mayActOnWork({ actor, action });
}

/**
 * The local player's access, from their actor and the CEO's name.
 *
 * Read-only means every CEO-only action is refused; checked against the rule
 * rather than the role, so the summary cannot claim a control is open that the
 * server would reject.
 *
 * @param ceoName `undefined` while the roster has not shown who holds the role.
 */
export function boardAccessFor(actor: OfficeActor, ceoName: string | undefined): BoardAccess {
  const mayAssign = mayAssignWork(actor);
  const readOnly = !mayAssign;
  const movesFor = (work: WorkData, people: readonly { readonly id: string }[]): WorkMove[] =>
    workMoves(work, actor, (id) => people.some((person) => person.id === id));
  if (!readOnly) {
    return {
      readOnly,
      summary: "You are the CEO: you hand the project board's issues to agents, and approve their work.",
      mayAssign,
      movesFor,
    };
  }
  const who = ceoName === undefined ? "the CEO" : `the CEO, ${ceoName},`;
  return {
    readOnly,
    mayAssign,
    movesFor,
    summary:
      `The project board is read-only for you: only ${who} can hand issues to agents, ` +
      "approve their work or send it back. You can read it and ask the manager about it.",
  };
}

const REJECTION_TEXT: Readonly<Record<WorkRejection, string>> = {
  [WORK_REJECTION.forbidden]: "Only the CEO can do that.",
  [WORK_REJECTION.unknownIssue]: "That issue is not open on the project board any more.",
  [WORK_REJECTION.noWork]: "Nobody is working that issue any more.",
  [WORK_REJECTION.illegalTransition]: "That work cannot move there from where it is now.",
  [WORK_REJECTION.unknownAssignee]: "That agent is no longer in the office.",
  [WORK_REJECTION.missingArtifact]: "That work has no deliverable to hand in yet.",
};

/** What to tell the player when the server refuses one of their commands. */
export function rejectionText(rejection: WorkRejection): string {
  return REJECTION_TEXT[rejection];
}
