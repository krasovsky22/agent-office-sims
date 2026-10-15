/**
 * The rules of the ticket board.
 *
 * `state.ts` says what a ticket *is*; this module says what may be *done* to
 * one. The split matters because the schema replicates to every browser while
 * these rules only ever run on the server: a client may mirror them to grey out
 * a drag target, but the copy here is the authority and the only one that
 * decides whether state changes.
 *
 * Four things live here:
 *
 * - {@link TICKET_TRANSITIONS}, the legal status edges, so a client that asks
 *   for an arbitrary jump is rejected rather than obeyed.
 * - {@link mayActOnTicket}, the one place authority is decided, reading the
 *   {@link TICKET_ACTION_AUTHORITY} table: the CEO runs the board, the agent
 *   employee a ticket is assigned to does the work on it, and everyone else
 *   may read it and comment. The client runs the same predicate to grey out a
 *   control, so what the panel offers is what the server will accept.
 * - {@link applyTicketCommand}, which validates a parsed command against the
 *   live board and mutates it, or rejects it and leaves the board untouched.
 * - {@link ticketForAgent}, which ticket an agent employee should pick up
 *   next, so that two agents can never be working the same one.
 *
 * Everything is synchronous and allocation-light, so a command handler can run
 * inside the room without the simulation tick ever having to wait on it.
 */

import { type MapSchema } from "@colyseus/schema";

import { MAX_TICKET_COMMENTS } from "./constants.js";
import {
  OCCUPANT_KIND,
  type Occupant,
  SYSTEM_AUTHOR_ID,
  TICKET_PRIORITIES,
  TICKET_STATUS,
  Ticket,
  TicketComment,
  type TicketStatus,
  type OccupantKind,
  isAgentEmployee,
  isCeo,
  isTicketPriority,
} from "./state.js";
import {
  type TicketAssignMessage,
  type TicketCommentMessage,
  type TicketCreateMessage,
  type TicketEditMessage,
  type TicketMoveStatusMessage,
  type TicketSetPriorityMessage,
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
  setPriority: "set-priority",
  comment: "comment",
  /** An agent starts on a ticket it was given: `assigned` -> `in_progress`. */
  claim: "claim",
  /** An agent writes its deliverable onto a ticket it is working. */
  attachOutput: "attach-output",
  /** An agent hands finished work in for review: `in_progress` -> `review`. */
  handIn: "hand-in",
} as const;

export type TicketAction = (typeof TICKET_ACTION)[keyof typeof TICKET_ACTION];

/** Who an action is open to. */
export const TICKET_AUTHORITY = {
  /** Only the player holding the CEO role. */
  ceo: "ceo",
  /** Anyone in the office. */
  anyone: "anyone",
  /** Only the agent employee the ticket is assigned to. */
  assignee: "assignee",
} as const;

export type TicketAuthority = (typeof TICKET_AUTHORITY)[keyof typeof TICKET_AUTHORITY];

/**
 * Who may perform each action: the board's authority rules, as data.
 *
 * The CEO decides and everyone else watches and advises, so every action that
 * changes what a ticket is, who owns it, where it stands or how much it matters
 * is the CEO's. That covers approving (`review` -> `done`) and rejecting
 * (`review` -> `in_progress`) along with every other status move.
 *
 * The assignee's own moves — starting work, attaching the deliverable, handing
 * it in — are the agent employee's, and only for a ticket the CEO gave it.
 * They are separate actions rather than a wider `move-status` because each is
 * exactly one step of the work: an agent can start what it was given and hand
 * in what it started, and nothing else, so it can neither pick its own work
 * from the backlog nor approve itself.
 *
 * Commenting is open to everyone, because it is how an executive advises on a
 * ticket they may not move, and how an agent says why it is stuck.
 *
 * Typed as a full record so that adding an action without deciding who may
 * perform it does not compile.
 */
export const TICKET_ACTION_AUTHORITY: Readonly<Record<TicketAction, TicketAuthority>> = {
  [TICKET_ACTION.create]: TICKET_AUTHORITY.ceo,
  [TICKET_ACTION.assign]: TICKET_AUTHORITY.ceo,
  [TICKET_ACTION.unassign]: TICKET_AUTHORITY.ceo,
  [TICKET_ACTION.moveStatus]: TICKET_AUTHORITY.ceo,
  [TICKET_ACTION.edit]: TICKET_AUTHORITY.ceo,
  [TICKET_ACTION.setPriority]: TICKET_AUTHORITY.ceo,
  [TICKET_ACTION.comment]: TICKET_AUTHORITY.anyone,
  [TICKET_ACTION.claim]: TICKET_AUTHORITY.assignee,
  [TICKET_ACTION.attachOutput]: TICKET_AUTHORITY.assignee,
  [TICKET_ACTION.handIn]: TICKET_AUTHORITY.assignee,
};

/**
 * Who is asking.
 *
 * A projection of {@link Occupant} rather than the occupant itself, so the
 * authority rules cannot come to depend on a position or an animation state.
 * Build one with {@link ticketActorOf} rather than by hand.
 */
export interface TicketActor {
  readonly id: string;
  readonly kind: OccupantKind;
  readonly isCeo: boolean;
}

/**
 * Projects an occupant to the actor the authority rule judges.
 *
 * Shared so that the server judging a command and the client deciding whether
 * to offer it read the role the same way.
 */
export function ticketActorOf(occupant: Occupant): TicketActor {
  return { id: occupant.id, kind: occupant.kind, isCeo: isCeo(occupant) };
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
 * Whether an actor may perform an action. **The one authority gate.**
 *
 * Every path in {@link applyTicketCommand} consults this exactly once, before
 * it validates anything else, and nothing else in the codebase decides ticket
 * authority: not a handler, not a message parser, not the transition table.
 * The client asks it too, to show a control as disabled rather than to decide
 * anything.
 *
 * Reads {@link TICKET_ACTION_AUTHORITY}, and the ticket only to see whether an
 * agent asking is the one it is assigned to. A player is never an assignee in
 * this sense, CEO included: the work on a ticket is the agent's, not a
 * shortcut the CEO can take past it.
 *
 * It returns a plain boolean on purpose. The caller already turns a `false`
 * into {@link TICKET_REJECTION.forbidden}, and the reason a player is refused
 * is always the same one: they are not the CEO.
 */
export function mayActOnTicket(query: TicketPermissionQuery): boolean {
  switch (TICKET_ACTION_AUTHORITY[query.action]) {
    case TICKET_AUTHORITY.anyone:
      return true;
    case TICKET_AUTHORITY.ceo:
      return query.actor.isCeo;
    case TICKET_AUTHORITY.assignee:
      return (
        query.actor.kind === OCCUPANT_KIND.agent &&
        query.ticket !== undefined &&
        query.ticket.assigneeId === query.actor.id
      );
  }
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
  /**
   * An edit that would change nothing, or clear the title entirely; also a
   * priority change to the priority the ticket already has.
   */
  emptyEdit: "empty-edit",
  /** A hand-in with no deliverable attached, or an attachment with no text. */
  missingArtifact: "missing-artifact",
} as const;

export type TicketRejection = (typeof TICKET_REJECTION)[keyof typeof TICKET_REJECTION];

/**
 * The ticket an agent's own command is about.
 *
 * Not a client message: no client message is an agent's, so these commands
 * are only ever built by the server, for the agent it is running.
 */
export interface TicketClaimPayload {
  readonly ticketId: string;
}

export interface TicketAttachOutputPayload {
  readonly ticketId: string;
  /** The deliverable, as the work executor returned it. Never empty. */
  readonly artifact: string;
}

export interface TicketHandInPayload {
  readonly ticketId: string;
}

/** A parsed command, tagged so the applier can switch on it. */
export type TicketCommand =
  | { readonly action: typeof TICKET_ACTION.create; readonly payload: TicketCreateMessage }
  | { readonly action: typeof TICKET_ACTION.assign; readonly payload: TicketAssignMessage }
  | { readonly action: typeof TICKET_ACTION.unassign; readonly payload: TicketUnassignMessage }
  | {
      readonly action: typeof TICKET_ACTION.moveStatus;
      readonly payload: TicketMoveStatusMessage;
    }
  | { readonly action: typeof TICKET_ACTION.edit; readonly payload: TicketEditMessage }
  | {
      readonly action: typeof TICKET_ACTION.setPriority;
      readonly payload: TicketSetPriorityMessage;
    }
  | { readonly action: typeof TICKET_ACTION.comment; readonly payload: TicketCommentMessage }
  | { readonly action: typeof TICKET_ACTION.claim; readonly payload: TicketClaimPayload }
  | {
      readonly action: typeof TICKET_ACTION.attachOutput;
      readonly payload: TicketAttachOutputPayload;
    }
  | { readonly action: typeof TICKET_ACTION.handIn; readonly payload: TicketHandInPayload };

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
    case TICKET_ACTION.setPriority:
      return setTicketPriority(ticket, command.payload, context);
    case TICKET_ACTION.comment:
      return commentOnTicket(ticket, command.payload, context);
    case TICKET_ACTION.claim:
      return claimTicket(ticket, context);
    case TICKET_ACTION.attachOutput:
      return attachTicketOutput(ticket, command.payload, context);
    case TICKET_ACTION.handIn:
      return handInTicket(ticket, context);
  }
}

function createTicket(
  payload: TicketCreateMessage,
  context: TicketCommandContext,
): TicketCommandResult {
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

/** Re-ranks a ticket. Finished work may be re-ranked; it changes no record. */
function setTicketPriority(
  ticket: Ticket,
  payload: TicketSetPriorityMessage,
  context: TicketCommandContext,
): TicketCommandResult {
  if (payload.priority === ticket.priority) {
    return reject(TICKET_REJECTION.emptyEdit);
  }

  ticket.priority = payload.priority;
  ticket.updatedAt = context.now;
  return { ok: true, ticket };
}

/**
 * Appends a comment, dropping the oldest once the ticket is at
 * {@link MAX_TICKET_COMMENTS}.
 *
 * Allowed on a ticket in any status, `done` included: a remark about finished
 * work changes no record of who did it.
 */
function commentOnTicket(
  ticket: Ticket,
  payload: TicketCommentMessage,
  context: TicketCommandContext,
): TicketCommandResult {
  const comment = new TicketComment();
  comment.authorId = context.actor.id;
  comment.text = payload.text;
  comment.createdAt = context.now;

  while (ticket.comments.length >= MAX_TICKET_COMMENTS) {
    ticket.comments.shift();
  }
  ticket.comments.push(comment);
  ticket.updatedAt = context.now;
  return { ok: true, ticket };
}

/**
 * An agent starts the ticket it was given.
 *
 * Only from `assigned`: a ticket already `in_progress` is being worked, by this
 * agent or one it was taken from, and claiming it again would change nothing.
 */
function claimTicket(ticket: Ticket, context: TicketCommandContext): TicketCommandResult {
  if (
    ticket.status !== TICKET_STATUS.assigned ||
    !isLegalTicketTransition(ticket.status, TICKET_STATUS.in_progress)
  ) {
    return reject(TICKET_REJECTION.illegalTransition);
  }

  ticket.status = TICKET_STATUS.in_progress;
  ticket.updatedAt = context.now;
  return { ok: true, ticket };
}

/**
 * An agent writes its deliverable onto the ticket it is working.
 *
 * Only while `in_progress`, so a deliverable can never land on work that was
 * pulled back to `assigned` or already approved. A rework replaces the last
 * one: the ticket holds what is up for review, not a history.
 */
function attachTicketOutput(
  ticket: Ticket,
  payload: TicketAttachOutputPayload,
  context: TicketCommandContext,
): TicketCommandResult {
  if (ticket.status !== TICKET_STATUS.in_progress) {
    return reject(TICKET_REJECTION.illegalTransition);
  }
  if (payload.artifact.trim() === "") {
    return reject(TICKET_REJECTION.missingArtifact);
  }

  ticket.outputArtifact = payload.artifact;
  ticket.updatedAt = context.now;
  return { ok: true, ticket };
}

/**
 * An agent hands its work in for the CEO to approve or send back.
 *
 * Refused without a deliverable on the ticket, so nothing reaches `review`
 * with nothing in it to review.
 */
function handInTicket(ticket: Ticket, context: TicketCommandContext): TicketCommandResult {
  if (
    ticket.status !== TICKET_STATUS.in_progress ||
    !isLegalTicketTransition(ticket.status, TICKET_STATUS.review)
  ) {
    return reject(TICKET_REJECTION.illegalTransition);
  }
  if (ticket.outputArtifact === "") {
    return reject(TICKET_REJECTION.missingArtifact);
  }

  ticket.status = TICKET_STATUS.review;
  ticket.updatedAt = context.now;
  return { ok: true, ticket };
}

/**
 * The ticket an agent employee should work on next, or `undefined`.
 *
 * Only tickets the CEO assigned to this agent, so an agent never chooses its
 * own work from the backlog. Both `assigned` (new work, to claim) and
 * `in_progress` (work sent back from review, or handed over from another agent)
 * qualify; an `in_progress` ticket another agent still holds as its
 * `currentTicketId` does not, so two agents can never be working the same
 * ticket, even for the moment after a reassignment while the first one is
 * still putting it down.
 *
 * Highest priority first, then oldest, then by id, so the choice is the same
 * every time for the same board.
 */
export function ticketForAgent(
  board: Iterable<Ticket>,
  occupants: Iterable<Occupant>,
  agentId: string,
): Ticket | undefined {
  const heldElsewhere = new Set<string>();
  for (const occupant of occupants) {
    if (isAgentEmployee(occupant) && occupant.id !== agentId && occupant.currentTicketId !== "") {
      heldElsewhere.add(occupant.currentTicketId);
    }
  }

  let best: Ticket | undefined;
  for (const ticket of board) {
    if (
      ticket.assigneeId !== agentId ||
      (ticket.status !== TICKET_STATUS.assigned && ticket.status !== TICKET_STATUS.in_progress) ||
      heldElsewhere.has(ticket.id)
    ) {
      continue;
    }
    if (best === undefined || comesFirst(ticket, best)) {
      best = ticket;
    }
  }
  return best;
}

function comesFirst(a: Ticket, b: Ticket): boolean {
  const rank = TICKET_PRIORITIES.indexOf(a.priority) - TICKET_PRIORITIES.indexOf(b.priority);
  if (rank !== 0) {
    return rank > 0;
  }
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt;
  }
  return a.id < b.id;
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
 * is not subject to the authority rule, which no actor exists yet to satisfy.
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
    if (!isTicketPriority(ticket.priority)) {
      problems.push(`ticket ${ticket.id} has unknown priority "${ticket.priority}"`);
    }
    if (ticket.comments.length > MAX_TICKET_COMMENTS) {
      problems.push(`ticket ${ticket.id} holds ${ticket.comments.length} comments`);
    }
  }
  return problems;
}
