/**
 * What the ticket board panel shows, worked out away from React.
 *
 * The panel renders whatever these functions hand it, so the parts worth
 * testing — which column a ticket lands in, whose name goes on a card, and
 * which moves are on offer — are plain functions of the replicated board and
 * the roster.
 *
 * This is also the panel's single door to the authority rules. Every "may this
 * player do that" the panel asks goes through {@link panelPermissions}, which
 * defers to the shared `ticketMoves` and `mayCreateTicket`, which defer in turn
 * to `mayActOnTicket` — the one predicate the server judges by. Tightening who
 * may act on the board is an edit there, and this panel follows it without
 * being touched.
 */

import {
  OCCUPANT_KIND,
  SYSTEM_AUTHOR_ID,
  TICKET_ACTION,
  TICKET_STATUS,
  TICKET_STATUSES,
  type TicketActor,
  type TicketData,
  type TicketMove,
  type TicketStatus,
  mayCreateTicket,
  ticketMoves,
} from "@sim/shared";

/** The roster fields the board reads; `Hud.tsx`'s entries satisfy it. */
export interface BoardPerson {
  readonly id: string;
  readonly name: string;
  readonly isCeo: boolean;
  readonly isLocal: boolean;
}

export const TICKET_COLUMN_TITLES: Readonly<Record<TicketStatus, string>> = {
  [TICKET_STATUS.backlog]: "Backlog",
  [TICKET_STATUS.assigned]: "Assigned",
  [TICKET_STATUS.in_progress]: "In progress",
  [TICKET_STATUS.review]: "Review",
  [TICKET_STATUS.done]: "Done",
};

export interface TicketColumn {
  readonly status: TicketStatus;
  readonly title: string;
  readonly tickets: readonly TicketData[];
}

/**
 * The board as five columns, in status order, oldest ticket first.
 *
 * Oldest first so a newly filed ticket joins the bottom of the backlog rather
 * than shoving every card down under the reader's cursor. Ids break a tie, so
 * two tabs agree on the order of tickets filed in the same millisecond.
 */
export function ticketColumns(tickets: readonly TicketData[]): TicketColumn[] {
  const sorted = [...tickets].sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id, "en", { numeric: true }),
  );
  return TICKET_STATUSES.map((status) => ({
    status,
    title: TICKET_COLUMN_TITLES[status],
    tickets: sorted.filter((ticket) => ticket.status === status),
  }));
}

/**
 * Who a card says owns it.
 *
 * An id with no matching occupant is an assignee who has left; the board shows
 * that rather than repairing it, as `state.ts` asks.
 */
export function assigneeLabel(ticket: TicketData, people: readonly BoardPerson[]): string {
  if (ticket.assigneeId === "") {
    return "Unassigned";
  }
  return people.find((person) => person.id === ticket.assigneeId)?.name ?? "Left the office";
}

/** Who filed a ticket, for its detail view. */
export function authorLabel(ticket: TicketData, people: readonly BoardPerson[]): string {
  if (ticket.createdById === SYSTEM_AUTHOR_ID) {
    return "The office";
  }
  return people.find((person) => person.id === ticket.createdById)?.name ?? "Someone who left";
}

/** What the button for a move reads. */
export function moveLabel(move: TicketMove): string {
  return move.action === TICKET_ACTION.assign
    ? "Assign to…"
    : `Move to ${TICKET_COLUMN_TITLES[move.to]}`;
}

/** What the local player may do on the board. */
export interface PanelPermissions {
  readonly mayCreate: boolean;
  readonly movesFor: (ticket: TicketData) => TicketMove[];
}

/** Offered while there is no local player to judge, i.e. before joining. */
const NO_PERMISSIONS: PanelPermissions = { mayCreate: false, movesFor: () => [] };

/**
 * The local player's permissions, from the roster.
 *
 * The local player is always a human: an agent is not driven by a browser.
 */
export function panelPermissions(people: readonly BoardPerson[]): PanelPermissions {
  const self = people.find((person) => person.isLocal);
  if (self === undefined) {
    return NO_PERMISSIONS;
  }
  const actor: TicketActor = { id: self.id, kind: OCCUPANT_KIND.human, isCeo: self.isCeo };
  return {
    mayCreate: mayCreateTicket(actor),
    movesFor: (ticket) => ticketMoves(ticket, actor),
  };
}
