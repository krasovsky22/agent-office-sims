/**
 * The rules of the ticket board.
 *
 * `state.ts` says what a ticket *is*; this module says what may be *done* to
 * one. The split matters because the schema replicates to every browser while
 * these rules only ever run on the server: a client may mirror them to grey out
 * a drag target, but the copy here is the authority and the only one that
 * decides whether state changes.
 *
 * Three things live here:
 *
 * - {@link TICKET_TRANSITIONS}, the legal status edges, so a client that asks
 *   for an arbitrary jump is rejected rather than obeyed.
 * - {@link mayActOnTicket}, the one place authority is decided. It is
 *   permissive today; the CEO-only rules are a later issue, and the point of
 *   funnelling every command through one predicate is that the issue is a
 *   single edit rather than a hunt.
 * - {@link applyTicketCommand}, which validates a parsed command against the
 *   live board and mutates it, or rejects it and leaves the board untouched.
 *
 * Everything is synchronous and allocation-light, so a command handler can run
 * inside the room without the simulation tick ever having to wait on it.
 */

import { type MapSchema } from "@colyseus/schema";

import {
  type Occupant,
  SYSTEM_AUTHOR_ID,
  TICKET_STATUS,
  Ticket,
  type TicketStatus,
  type OccupantKind,
} from "./state.js";
import {
  type TicketAssignMessage,
  type TicketCreateMessage,
  type TicketEditMessage,
  type TicketMoveStatusMessage,
  type TicketUnassignMessage,
} from "./messages.js";

/**
 * The legal status edges, as adjacency.
 *
 * Read it as "from -> the statuses you may move to". Two shapes fall out of it
 * and both are deliberate:
 *
 * - Work moves forward one column at a time and can always be pushed back one
 *   column, so a reviewer can return a ticket for rework and the CEO can pull
 *   a started ticket back into the queue.
 * - `done` is terminal. Reopening finished work is a product decision nobody
 *   has made; adding the edge later is one line here plus a test, whereas
 *   unpicking a half-reopened ticket from four consumers is not.
 *
 * The one edge not reachable by {@link TICKET_STATUS.backlog} -> `assigned`
 * alone is that same edge: it is legal, but it also needs an assignee, which
 * only {@link TICKET_ACTION.assign} supplies. See {@link assigneeInvariant}.
 */
export const TICKET_TRANSITIONS: Readonly<Record<TicketStatus, readonly TicketStatus[]>> = {
  [TICKET_STATUS.backlog]: [TICKET_STATUS.assigned],
  [TICKET_STATUS.assigned]: [TICKET_STATUS.backlog, TICKET_STATUS.in_progress],
  [TICKET_STATUS.in_progress]: [TICKET_STATUS.assigned, TICKET_STATUS.review],
  [TICKET_STATUS.review]: [TICKET_STATUS.in_progress, TICKET_STATUS.done],
  [TICKET_STATUS.done]: [],
};

/** Whether `to` is reachable from `from` in one move. A self-move is not. */
export function isLegalTicketTransition(from: TicketStatus, to: TicketStatus): boolean {
  return TICKET_TRANSITIONS[from].includes(to);
}

/** The statuses `from` may move to, for a consumer offering the choice. */
export function legalTicketTransitions(from: TicketStatus): readonly TicketStatus[] {
  return TICKET_TRANSITIONS[from];
}

/**
 * Whether a status requires an assignee.
 *
 * Every ticket on the board satisfies this: `backlog` means nobody owns it, and
 * anything past `backlog` records who took it — including `done`, which keeps
 * the assignee as the record of who finished it. Consumers may rely on it, so
 * the command rules below enforce it on every write.
 */
export function assigneeInvariant(status: TicketStatus): boolean {
  return status !== TICKET_STATUS.backlog;
}

/** What a command wants to do, for the authority check. */
export const TICKET_ACTION = {
  create: "create",
  assign: "assign",
  unassign: "unassign",
  moveStatus: "move-status",
  edit: "edit",
} as const;

export type TicketAction = (typeof TICKET_ACTION)[keyof typeof TICKET_ACTION];

/**
 * Who is asking.
 *
 * A projection of {@link Occupant} rather than the occupant itself, so the
 * authority rules cannot come to depend on a position or an animation state.
 */
export interface TicketActor {
  readonly id: string;
  readonly kind: OccupantKind;
  readonly isCeo: boolean;
}

/** A single authority question: may this actor do this to this ticket? */
export interface TicketPermissionQuery {
  readonly actor: TicketActor;
  readonly action: TicketAction;
  /** The ticket being acted on; absent for {@link TICKET_ACTION.create}. */
  readonly ticket?: Ticket;
}

/** The shape {@link mayActOnTicket} satisfies, so a caller can substitute one. */
export type TicketPermission = (query: TicketPermissionQuery) => boolean;

/**
 * Whether an actor may perform an action. **The seam, and permissive for now.**
 *
 * Every path in {@link applyTicketCommand} consults this exactly once, before
 * it validates anything else, and nothing else in the codebase decides ticket
 * authority. The issue that makes the board CEO-only replaces this body; it
 * should not need to touch a handler, a message parser, or the transition
 * table.
 *
 * It returns a plain boolean on purpose. A reason string would be a second
 * thing for the replacement to get right, and the caller already turns a `false`
 * into {@link TICKET_REJECTION.forbidden}.
 */
export function mayActOnTicket(_query: TicketPermissionQuery): boolean {
  return true;
}

/** Why a command was refused. Rejection never changes the board. */
export const TICKET_REJECTION = {
  /** The authority seam said no. */
  forbidden: "forbidden",
  /** No ticket on the board has that id. */
  unknownTicket: "unknown-ticket",
  /** The requested status is not reachable from the current one. */
  illegalTransition: "illegal-transition",
  /** The named assignee is not in the office. */
  unknownAssignee: "unknown-assignee",
  /** The move would leave a non-`backlog` ticket with no assignee. */
  missingAssignee: "missing-assignee",
  /** An edit that would change nothing, or clear the title entirely. */
  emptyEdit: "empty-edit",
  /** The board is at {@link MAX_BOARD_TICKETS}. */
  boardFull: "board-full",
} as const;

export type TicketRejection = (typeof TICKET_REJECTION)[keyof typeof TICKET_REJECTION];

/**
 * Tickets one room will hold.
 *
 * A bound rather than a design target: the board is in memory and a client can
 * send `create` as fast as it likes, so something has to stop a single tab
 * growing the replicated state without limit.
 */
export const MAX_BOARD_TICKETS = 200;

/** A parsed command, tagged so the applier can switch on it. */
export type TicketCommand =
  | { readonly action: typeof TICKET_ACTION.create; readonly payload: TicketCreateMessage }
  | { readonly action: typeof TICKET_ACTION.assign; readonly payload: TicketAssignMessage }
  | { readonly action: typeof TICKET_ACTION.unassign; readonly payload: TicketUnassignMessage }
  | {
      readonly action: typeof TICKET_ACTION.moveStatus;
      readonly payload: TicketMoveStatusMessage;
    }
  | { readonly action: typeof TICKET_ACTION.edit; readonly payload: TicketEditMessage };

/**
 * Everything a command needs that is not in its own payload.
 *
 * `now` is passed in rather than read from the clock so that the rules are a
 * pure function of their inputs, which is what makes them testable without a
 * running room.
 */
export interface TicketCommandContext {
  readonly board: MapSchema<Ticket>;
  /** Consulted to resolve an assignee; the room's occupants map. */
  readonly occupants: MapSchema<Occupant>;
  readonly actor: TicketActor;
  /** Epoch milliseconds to stamp on whatever the command changes. */
  readonly now: number;
  /** Mints an id for a created ticket. */
  readonly nextTicketId: () => string;
  /** Defaults to {@link mayActOnTicket}. */
  readonly permit?: TicketPermission;
}

export type TicketCommandResult =
  | { readonly ok: true; readonly ticket: Ticket }
  | { readonly ok: false; readonly rejection: TicketRejection };

function reject(rejection: TicketRejection): TicketCommandResult {
  return { ok: false, rejection };
}

/**
 * Validates a command against the live board and applies it, or rejects it.
 *
 * Nothing is written unless every check passes, so a rejected command leaves
 * the board byte-identical and there is no half-applied state for a client to
 * observe.
 *
 * Commands are resolved against the board *as it is now*, never against a view
 * the client sent along. Colyseus delivers a room's messages one at a time on
 * one thread, so two clients dragging the same ticket are two sequential calls
 * here: the first wins the transition and the second is measured against the
 * result, which is why a stale drag is rejected instead of racing. Last write
 * wins for an edit, and both clients then receive the same board.
 */
export function applyTicketCommand(
  command: TicketCommand,
  context: TicketCommandContext,
): TicketCommandResult {
  const permit = context.permit ?? mayActOnTicket;

  if (command.action === TICKET_ACTION.create) {
    if (!permit({ actor: context.actor, action: TICKET_ACTION.create })) {
      return reject(TICKET_REJECTION.forbidden);
    }
    return createTicket(command.payload, context);
  }

  const ticket = context.board.get(command.payload.ticketId);
  if (ticket === undefined) {
    return reject(TICKET_REJECTION.unknownTicket);
  }
  if (!permit({ actor: context.actor, action: command.action, ticket })) {
    return reject(TICKET_REJECTION.forbidden);
  }

  switch (command.action) {
    case TICKET_ACTION.assign:
      return assignTicket(ticket, command.payload, context);
    case TICKET_ACTION.unassign:
      return unassignTicket(ticket, context);
    case TICKET_ACTION.moveStatus:
      return moveTicketStatus(ticket, command.payload, context);
    case TICKET_ACTION.edit:
      return editTicket(ticket, command.payload, context);
  }
}

function createTicket(
  payload: TicketCreateMessage,
  context: TicketCommandContext,
): TicketCommandResult {
  if (context.board.size >= MAX_BOARD_TICKETS) {
    return reject(TICKET_REJECTION.boardFull);
  }

  const ticket = new Ticket();
  ticket.id = context.nextTicketId();
  ticket.title = payload.title;
  ticket.body = payload.body;
  ticket.status = TICKET_STATUS.backlog;
  ticket.assigneeId = "";
  ticket.createdById = context.actor.id;
  ticket.outputArtifact = "";
  ticket.createdAt = context.now;
  ticket.updatedAt = context.now;

  context.board.set(ticket.id, ticket);
  return { ok: true, ticket };
}

/**
 * Gives a ticket an owner.
 *
 * This is the only way out of `backlog`, which is why the transition is checked
 * here too rather than left to `move-status`: a ticket cannot be `assigned`
 * without someone to assign it to, and `assign` is the command that has one.
 * Assigning a ticket that already has an owner is a reassignment and leaves the
 * status alone — pulling an `in_progress` ticket back to `assigned` because it
 * changed hands would lose the fact that work had started.
 */
function assignTicket(
  ticket: Ticket,
  payload: TicketAssignMessage,
  context: TicketCommandContext,
): TicketCommandResult {
  if (ticket.status === TICKET_STATUS.done) {
    // Reassigning finished work would rewrite the record of who did it, and
    // `done` has no outgoing edge to carry the change anyway.
    return reject(TICKET_REJECTION.illegalTransition);
  }
  if (!context.occupants.has(payload.assigneeId)) {
    return reject(TICKET_REJECTION.unknownAssignee);
  }

  const status =
    ticket.status === TICKET_STATUS.backlog ? TICKET_STATUS.assigned : ticket.status;
  // Holds today, since the table lists that edge. Checked rather than assumed
  // so the table stays the authority if someone edits it.
  if (status !== ticket.status && !isLegalTicketTransition(ticket.status, status)) {
    return reject(TICKET_REJECTION.illegalTransition);
  }

  ticket.assigneeId = payload.assigneeId;
  ticket.status = status;
  ticket.updatedAt = context.now;
  return { ok: true, ticket };
}

/**
 * Returns a ticket to the queue, which by the invariant clears its assignee.
 *
 * Only `assigned` steps straight back, because that is the only edge into
 * `backlog` in the table. Work that has started is walked back a column at a
 * time instead, so nobody discards a review by dropping its assignee; an
 * already-`backlog` ticket has no edge to itself and is refused too.
 */
function unassignTicket(ticket: Ticket, context: TicketCommandContext): TicketCommandResult {
  if (!isLegalTicketTransition(ticket.status, TICKET_STATUS.backlog)) {
    return reject(TICKET_REJECTION.illegalTransition);
  }

  ticket.assigneeId = "";
  ticket.status = TICKET_STATUS.backlog;
  ticket.updatedAt = context.now;
  return { ok: true, ticket };
}

function moveTicketStatus(
  ticket: Ticket,
  payload: TicketMoveStatusMessage,
  context: TicketCommandContext,
): TicketCommandResult {
  if (!isLegalTicketTransition(ticket.status, payload.status)) {
    return reject(TICKET_REJECTION.illegalTransition);
  }

  const clearsAssignee = !assigneeInvariant(payload.status);
  if (!clearsAssignee && ticket.assigneeId === "") {
    // Reachable only as `backlog` -> `assigned`, which `assign` owns.
    return reject(TICKET_REJECTION.missingAssignee);
  }

  ticket.status = payload.status;
  if (clearsAssignee) {
    ticket.assigneeId = "";
  }
  ticket.updatedAt = context.now;
  return { ok: true, ticket };
}

/**
 * Rewrites a ticket's text.
 *
 * Omitted fields are left alone, so a client editing only the title does not
 * have to echo the body back. An edit that would blank the title is refused:
 * a ticket with no title is unreadable on a board, and the client has a delete
 * for a ticket it no longer wants — or will, when there is one.
 */
function editTicket(
  ticket: Ticket,
  payload: TicketEditMessage,
  context: TicketCommandContext,
): TicketCommandResult {
  const title = payload.title ?? ticket.title;
  const body = payload.body ?? ticket.body;

  if (title === "") {
    return reject(TICKET_REJECTION.emptyEdit);
  }
  if (title === ticket.title && body === ticket.body) {
    return reject(TICKET_REJECTION.emptyEdit);
  }

  ticket.title = title;
  ticket.body = body;
  ticket.updatedAt = context.now;
  return { ok: true, ticket };
}

/**
 * Text of the tickets a fresh room starts with.
 *
 * Data, like the floor plan, and for the same reason: the board panel, the CEO
 * verbs and the metrics all want something real to render, and they should all
 * be looking at the same something.
 *
 * All five start in `backlog` because a fresh room has no occupants to assign
 * them to, and a seeded ticket pointing at an assignee who is not in the office
 * would break the one invariant four downstream consumers are being handed.
 */
export const STARTER_TICKETS: readonly { readonly title: string; readonly body: string }[] = [
  {
    title: "Fix the login redirect loop",
    body: "Signing in from the pricing page bounces between /login and /app until the tab is closed. Reproduces in a fresh profile.",
  },
  {
    title: "Write the onboarding email",
    body: "One message, sent an hour after signup. Say what the product does and link the two-minute walkthrough. Nothing else.",
  },
  {
    title: "Cut the dashboard load time",
    body: "First paint is over four seconds on a cold cache. The summary query is the obvious suspect but measure before touching it.",
  },
  {
    title: "Audit the third-party licences",
    body: "List every dependency, its licence, and anything that is not permissive. Flag what would block shipping a binary.",
  },
  {
    title: "Draft the Q3 roadmap",
    body: "Three themes, no more. Each one needs a sentence a customer would understand and a reason it is ahead of the alternatives.",
  },
];

/**
 * Fills an empty board with {@link STARTER_TICKETS}.
 *
 * Attributed to {@link SYSTEM_AUTHOR_ID} rather than to a player, since the
 * room writes them before anyone has joined. Bypasses
 * {@link applyTicketCommand} deliberately: a seed is not an actor's command and
 * should not be subject to an authority rule that a later issue may tighten.
 */
export function seedBoard(
  board: MapSchema<Ticket>,
  now: number,
  nextTicketId: () => string,
): void {
  for (const seed of STARTER_TICKETS) {
    const ticket = new Ticket();
    ticket.id = nextTicketId();
    ticket.title = seed.title;
    ticket.body = seed.body;
    ticket.status = TICKET_STATUS.backlog;
    ticket.createdById = SYSTEM_AUTHOR_ID;
    ticket.createdAt = now;
    ticket.updatedAt = now;
    board.set(ticket.id, ticket);
  }
}

/**
 * Checks the invariants every ticket on the board is meant to satisfy.
 *
 * Exported for tests in the same spirit as `describeLayoutProblems`: a board
 * that breaks one of these is a board a downstream panel will render wrongly,
 * and that is far cheaper to catch here.
 */
export function describeBoardProblems(board: MapSchema<Ticket>): string[] {
  const problems: string[] = [];
  for (const [key, ticket] of board) {
    if (key !== ticket.id) {
      problems.push(`ticket keyed ${key} carries id ${ticket.id}`);
    }
    if (ticket.title === "") {
      problems.push(`ticket ${ticket.id} has no title`);
    }
    if (assigneeInvariant(ticket.status) !== (ticket.assigneeId !== "")) {
      problems.push(`ticket ${ticket.id} is ${ticket.status} with assignee "${ticket.assigneeId}"`);
    }
    if (ticket.updatedAt < ticket.createdAt) {
      problems.push(`ticket ${ticket.id} was updated before it was created`);
    }
  }
  return problems;
}
