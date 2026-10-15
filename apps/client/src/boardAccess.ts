/**
 * What the local player may do to the ticket board, in words the HUD can show.
 *
 * The decision is not made here. `mayActOnTicket` in `@sim/shared` is the rule
 * the server enforces, and this module only asks it the same question about the
 * local player, so a control is disabled exactly when the server would refuse
 * it. Everything a board control needs — whether to offer it, which moves are
 * on offer, and what to say when it is not — comes from this one place, so the
 * board panel has a single import to gate on rather than a role check of its
 * own.
 */

import {
  TICKET_REJECTION,
  type TicketAction,
  type TicketActor,
  type TicketData,
  type TicketMove,
  type TicketRejection,
  mayActOnTicket,
  mayCreateTicket,
  ticketMoves,
} from "@sim/shared";

/** The local player's standing at the board. */
export interface BoardAccess {
  /** Whether the board is read-only for this player apart from commenting. */
  readonly readOnly: boolean;
  /** One sentence on what this player may do, and why, for the HUD. */
  readonly summary: string;
  /** Whether the board panel offers to file a new ticket. */
  readonly mayCreate: boolean;
  /** The moves the board panel offers on `ticket`; the shared planner's answer. */
  readonly movesFor: (ticket: TicketData) => TicketMove[];
}

/** Whether `actor` may perform `action`; the server's own rule. */
export function mayAct(actor: TicketActor, action: TicketAction): boolean {
  return mayActOnTicket({ actor, action });
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
export function boardAccessFor(actor: TicketActor, ceoName: string | undefined): BoardAccess {
  const mayCreate = mayCreateTicket(actor);
  const readOnly = !mayCreate;
  const movesFor = (ticket: TicketData): TicketMove[] => ticketMoves(ticket, actor);
  if (!readOnly) {
    return {
      readOnly,
      summary: "You are the CEO: you create, assign, prioritise and approve the work.",
      mayCreate,
      movesFor,
    };
  }
  const who = ceoName === undefined ? "the CEO" : `the CEO, ${ceoName},`;
  return {
    readOnly,
    mayCreate,
    movesFor,
    summary:
      `The ticket board is read-only for you: only ${who} can create, assign, ` +
      "prioritise, approve or reject tickets. You can read it and comment.",
  };
}

const REJECTION_TEXT: Readonly<Record<TicketRejection, string>> = {
  [TICKET_REJECTION.forbidden]: "Only the CEO can do that.",
  [TICKET_REJECTION.unknownTicket]: "That ticket is no longer on the board.",
  [TICKET_REJECTION.illegalTransition]: "That ticket cannot move there from where it is now.",
  [TICKET_REJECTION.unknownAssignee]: "That person is no longer in the office.",
  [TICKET_REJECTION.missingAssignee]: "Assign the ticket to someone first.",
  [TICKET_REJECTION.emptyEdit]: "That would not change anything.",
  [TICKET_REJECTION.missingArtifact]: "That ticket has no deliverable to hand in yet.",
};

/** What to tell the player when the server refuses one of their commands. */
export function rejectionText(rejection: TicketRejection): string {
  return REJECTION_TEXT[rejection];
}
