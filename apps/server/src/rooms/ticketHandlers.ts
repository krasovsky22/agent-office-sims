/**
 * The room's ticket command handlers.
 *
 * Thin by design. Each handler does three things and nothing else: parse the
 * untrusted payload, resolve the sender to a {@link TicketActor}, and hand both
 * to `applyTicketCommand`, which owns every rule. No handler reads a status, a
 * transition or an authority rule of its own, so the CEO-authority issue has
 * one place to change and this file is not it.
 *
 * All of it is synchronous. Colyseus delivers a room's messages one at a time,
 * so the board is only ever mutated between simulation ticks and the tick never
 * has to wait on a command.
 */

import { type Client, type Room } from "@colyseus/core";
import {
  CLIENT_MESSAGE,
  type OfficeState,
  TICKET_ACTION,
  type TicketActor,
  type TicketCommand,
  type TicketCommandResult,
  applyTicketCommand,
  isHumanPlayer,
  parseTicketAssignMessage,
  parseTicketCreateMessage,
  parseTicketEditMessage,
  parseTicketMoveStatusMessage,
  parseTicketUnassignMessage,
  seedBoard,
} from "@sim/shared";

/** What the handlers need from the room, named so a test can supply it. */
export interface TicketHost {
  readonly state: OfficeState;
  /** Epoch milliseconds to stamp on a change. */
  readonly now: () => number;
  /** Mints an id for a created ticket. */
  readonly nextTicketId: () => string;
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
  if (occupant === undefined) {
    return undefined;
  }
  return {
    id: occupant.id,
    kind: occupant.kind,
    isCeo: isHumanPlayer(occupant) && occupant.isCeo,
  };
}

/**
 * Runs one command on behalf of a client.
 *
 * @returns the result, or `undefined` if the payload or the sender did not
 * resolve. A rejection leaves the board unchanged; like a malformed pose, it is
 * dropped rather than answered. Telling the sender why would need a
 * server -> client message, which the board panel issue can add once it knows
 * what it wants to show.
 */
export function runTicketCommand(
  host: TicketHost,
  client: Client,
  command: TicketCommand,
): TicketCommandResult | undefined {
  const actor = actorFor(host.state, client);
  if (actor === undefined) {
    return undefined;
  }
  return applyTicketCommand(command, {
    board: host.state.tickets,
    occupants: host.state.occupants,
    actor,
    now: host.now(),
    nextTicketId: host.nextTicketId,
  });
}

/** Puts the starter tickets on an empty board. */
export function seedTicketBoard(host: TicketHost): void {
  seedBoard(host.state.tickets, host.now(), host.nextTicketId);
}

/**
 * Registers the five ticket handlers on a room.
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
}
