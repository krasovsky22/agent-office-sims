/**
 * The room's ticket command handlers.
 *
 * Thin by design. Each handler does three things and nothing else: parse the
 * untrusted payload, resolve the sender to a {@link TicketActor}, and hand both
 * to `applyTicketCommand`, which owns every rule. No handler reads a status, a
 * transition or an authority rule of its own: who may do what is decided once,
 * by `mayActOnTicket` in `@sim/shared`'s `tickets.ts`, and this file is not it.
 *
 * A refused command is answered, to its sender only, with the reason. The
 * board is unchanged either way; the answer is what lets an executive's client
 * say "only the CEO can do that" instead of nothing.
 *
 * Agent employees act on the board through the same rules, by
 * {@link runAgentTicketCommand}: the only difference is who the actor is and
 * that nobody needs answering.
 *
 * All of it is synchronous. Colyseus delivers a room's messages one at a time,
 * so the board is only ever mutated between simulation ticks and the tick never
 * has to wait on a command.
 */

import { type Client, type Room } from "@colyseus/core";
import {
  CLIENT_MESSAGE,
  type OfficeState,
  SERVER_MESSAGE,
  TICKET_ACTION,
  type TicketAction,
  type TicketActor,
  type TicketCommand,
  type TicketCommandResult,
  type TicketRejectedEvent,
  applyTicketCommand,
  isAgentEmployee,
  parseTicketAssignMessage,
  parseTicketCommentMessage,
  parseTicketCreateMessage,
  parseTicketEditMessage,
  parseTicketMoveStatusMessage,
  parseTicketSetPriorityMessage,
  parseTicketUnassignMessage,
  seedBoard,
  ticketActorOf,
} from "@sim/shared";

/** What the handlers need from the room, named so a test can supply it. */
export interface TicketHost {
  readonly state: OfficeState;
  /** Epoch milliseconds to stamp on a change. */
  readonly now: () => number;
  /** Mints an id for a created ticket. */
  readonly nextTicketId: () => string;
  /**
   * Charges a command against the sender's rate limit, after it has parsed.
   * `false` drops the command unapplied and unanswered; the limiter tells the
   * client itself. Absent means nothing is limited.
   */
  readonly allow?: (client: Client, action: TicketAction) => boolean;
}

/**
 * Mints ticket ids for one room.
 *
 * Sequential rather than random: the ids appear in a replicated map key and in
 * logs, and `ticket-7` is far easier to follow across two browser tabs than a
 * uuid. They are unique within a room, which is the only scope that holds a
 * board.
 */
export function createTicketIdFactory(): () => string {
  let next = 1;
  return () => {
    const id = `ticket-${next}`;
    next += 1;
    return id;
  };
}

/**
 * Resolves a connected client to the actor the authority seam will judge.
 *
 * An occupant that is not in the map — a message that arrived in the gap
 * between a disconnect and its `onLeave` — yields `undefined`, and the command
 * is dropped. The alternative, inventing a default actor, would hand a
 * disconnected session the permissions of a present one.
 */
function actorFor(state: OfficeState, client: Client): TicketActor | undefined {
  const occupant = state.occupants.get(client.sessionId);
  return occupant === undefined ? undefined : ticketActorOf(occupant);
}

/**
 * Runs one command on behalf of a client.
 *
 * The actor is resolved from the replicated occupant at the moment the command
 * arrives, so the role it is judged by is the role the server holds now — not
 * one the client claims, and not one it held before a succession.
 *
 * @returns the result, or `undefined` if the sender did not resolve or the
 * rate limit dropped the command. A rejection leaves the board unchanged and
 * is reported to the sender as a {@link TicketRejectedEvent}.
 */
export function runTicketCommand(
  host: TicketHost,
  client: Client,
  command: TicketCommand,
): TicketCommandResult | undefined {
  const actor = actorFor(host.state, client);
  if (actor === undefined || host.allow?.(client, command.action) === false) {
    return undefined;
  }
  const result = applyTicketCommand(command, {
    board: host.state.tickets,
    occupants: host.state.occupants,
    actor,
    now: host.now(),
    nextTicketId: host.nextTicketId,
  });
  if (!result.ok) {
    client.send(SERVER_MESSAGE.ticketRejected, {
      action: command.action,
      rejection: result.rejection,
    } satisfies TicketRejectedEvent);
  }
  return result;
}

/**
 * Runs one command on behalf of an agent employee.
 *
 * The agent's counterpart to {@link runTicketCommand}, judged by the same
 * `applyTicketCommand` and the same authority gate, with the agent as the
 * actor. An agent has no client, so a refusal is returned to its brain rather
 * than sent anywhere; and it is not rate-limited, because a brain issues a
 * handful of commands per ticket and no client can make it issue more.
 *
 * @returns the result, or `undefined` if `agentId` is not an agent in the office.
 */
export function runAgentTicketCommand(
  host: TicketHost,
  agentId: string,
  command: TicketCommand,
): TicketCommandResult | undefined {
  const occupant = host.state.occupants.get(agentId);
  if (occupant === undefined || !isAgentEmployee(occupant)) {
    return undefined;
  }
  return applyTicketCommand(command, {
    board: host.state.tickets,
    occupants: host.state.occupants,
    actor: ticketActorOf(occupant),
    now: host.now(),
    nextTicketId: host.nextTicketId,
  });
}

/** Puts the starter tickets on an empty board. */
export function seedTicketBoard(host: TicketHost): void {
  seedBoard(host.state.tickets, host.now(), host.nextTicketId);
}

/**
 * Registers the seven ticket handlers on a room.
 *
 * Takes the room's `onMessage` rather than the room, so the host object above
 * stays the whole of what these handlers can reach.
 */
export function registerTicketHandlers(
  room: Pick<Room<OfficeState>, "onMessage">,
  host: TicketHost,
): void {
  room.onMessage(CLIENT_MESSAGE.ticketCreate, (client, raw: unknown) => {
    const payload = parseTicketCreateMessage(raw);
    if (payload !== undefined) {
      runTicketCommand(host, client, { action: TICKET_ACTION.create, payload });
    }
  });

  room.onMessage(CLIENT_MESSAGE.ticketAssign, (client, raw: unknown) => {
    const payload = parseTicketAssignMessage(raw);
    if (payload !== undefined) {
      runTicketCommand(host, client, { action: TICKET_ACTION.assign, payload });
    }
  });

  room.onMessage(CLIENT_MESSAGE.ticketUnassign, (client, raw: unknown) => {
    const payload = parseTicketUnassignMessage(raw);
    if (payload !== undefined) {
      runTicketCommand(host, client, { action: TICKET_ACTION.unassign, payload });
    }
  });

  room.onMessage(CLIENT_MESSAGE.ticketMoveStatus, (client, raw: unknown) => {
    const payload = parseTicketMoveStatusMessage(raw);
    if (payload !== undefined) {
      runTicketCommand(host, client, { action: TICKET_ACTION.moveStatus, payload });
    }
  });

  room.onMessage(CLIENT_MESSAGE.ticketEdit, (client, raw: unknown) => {
    const payload = parseTicketEditMessage(raw);
    if (payload !== undefined) {
      runTicketCommand(host, client, { action: TICKET_ACTION.edit, payload });
    }
  });

  room.onMessage(CLIENT_MESSAGE.ticketSetPriority, (client, raw: unknown) => {
    const payload = parseTicketSetPriorityMessage(raw);
    if (payload !== undefined) {
      runTicketCommand(host, client, { action: TICKET_ACTION.setPriority, payload });
    }
  });

  room.onMessage(CLIENT_MESSAGE.ticketComment, (client, raw: unknown) => {
    const payload = parseTicketCommentMessage(raw);
    if (payload !== undefined) {
      runTicketCommand(host, client, { action: TICKET_ACTION.comment, payload });
    }
  });
}
