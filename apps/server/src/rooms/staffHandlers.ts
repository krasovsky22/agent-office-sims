/**
 * The room's hire and fire handlers, and the announcement of every staff change.
 *
 * Thin for the same reason the ticket handlers are: each one parses the
 * untrusted payload, resolves the sender to an actor, and hands both to
 * `applyStaffCommand` in `@sim/shared`'s `staffing.ts`, which decides whether
 * the sender may, whether there is a desk, and whether the company can pay.
 * A refusal is answered to the sender alone, with its reason.
 *
 * What only the room can do lives here: counting the hires it has made, so the
 * next one gets a fresh id and name, and telling everyone what happened. A
 * departure is announced with the agent's name and title, because by the time
 * a client reads the announcement the agent is already gone from the state.
 *
 * All of it is synchronous. Hiring and firing are message handlers; a quit is
 * resolved in the simulation tick through {@link resolveStaffQuits}, which
 * reads one number on every tick but midnight.
 */

import { type Client, type Room } from "@colyseus/core";
import {
  CLIENT_MESSAGE,
  type Departure,
  OFFICE_LAYOUT,
  type OfficeState,
  QUIT_REASON,
  SERVER_MESSAGE,
  STAFF_ACTION,
  STAFF_CHANGE,
  type StaffChangedEvent,
  type StaffCommand,
  type StaffCommandResult,
  type StaffRejectedEvent,
  applyStaffCommand,
  isDueToQuit,
  parseStaffFireMessage,
  parseStaffHireMessage,
  resolveQuitting,
  ticketActorOf,
} from "@sim/shared";

import { recordOfficeEvent } from "../sim/events.js";

/** What the handlers need from the room, named so a test can supply it. */
export interface StaffHost {
  readonly state: OfficeState;
  /** Epoch milliseconds to stamp on a ticket a departure hands back. */
  readonly now: () => number;
  /**
   * Agents hired since the room opened, the starting staff included. Bumped by
   * every successful hire and never lowered, so a firing frees a desk without
   * freeing the fired agent's id for the next hire.
   */
  hiresSoFar: number;
  /** Called with each agent a hire puts on the floor, so the room can start it working. */
  readonly hired: (agentId: string) => void;
  /** Called with each agent a firing or a quit takes off the floor. */
  readonly departed: (agentId: string) => void;
}

type Announcer = Pick<Room<OfficeState>, "broadcast">;

/**
 * Runs one hire or fire on behalf of a client.
 *
 * @returns the result, or `undefined` if the sender is not in the office.
 */
export function runStaffCommand(
  room: Announcer,
  host: StaffHost,
  client: Client,
  command: StaffCommand,
): StaffCommandResult | undefined {
  const occupant = host.state.occupants.get(client.sessionId);
  if (occupant === undefined) {
    return undefined;
  }
  const result = applyStaffCommand(command, {
    layout: OFFICE_LAYOUT,
    occupants: host.state.occupants,
    board: host.state.tickets,
    company: host.state.company,
    actor: ticketActorOf(occupant),
    now: host.now(),
    hiresSoFar: host.hiresSoFar,
  });
  if (!result.ok) {
    client.send(SERVER_MESSAGE.staffRejected, {
      action: command.action,
      rejection: result.rejection,
    } satisfies StaffRejectedEvent);
    return result;
  }

  // Logged here rather than in `announce`, which a quit reaches from the tick.
  recordOfficeEvent(`staff-${command.action}`, {
    actor: occupant.name,
    agent: result.action === STAFF_ACTION.hire ? result.agent.id : result.departure.agent.id,
  });
  if (result.action === STAFF_ACTION.hire) {
    host.hiresSoFar += 1;
    const { agent, fee } = result;
    host.hired(agent.id);
    announce(room, {
      change: STAFF_CHANGE.hired,
      agentId: agent.id,
      name: agent.name,
      jobTitle: agent.jobTitle,
      salary: agent.salary,
      fee,
    });
  } else {
    const { departure, moraleLost } = result;
    host.departed(departure.agent.id);
    announce(room, {
      change: STAFF_CHANGE.fired,
      ...departed(departure),
      moraleLost,
      releasedTickets: departure.releasedTicketIds.length,
    });
  }
  return result;
}

/**
 * Lets a long enough run of low-morale days claim an agent, and says so.
 *
 * Called from the tick after the company clock has stepped. On every tick but
 * the one that closed a bad enough day it is a single comparison.
 */
export function resolveStaffQuits(room: Announcer, host: StaffHost): void {
  if (!isDueToQuit(host.state.company)) {
    return;
  }
  const departure: Departure | undefined = resolveQuitting({
    occupants: host.state.occupants,
    board: host.state.tickets,
    company: host.state.company,
    now: host.now(),
  });
  if (departure !== undefined) {
    host.departed(departure.agent.id);
    announce(room, {
      change: STAFF_CHANGE.quit,
      ...departed(departure),
      reason: QUIT_REASON,
      releasedTickets: departure.releasedTicketIds.length,
    });
  }
}

function departed({ agent }: Departure) {
  return { agentId: agent.id, name: agent.name, jobTitle: agent.jobTitle, salary: agent.salary };
}

function announce(room: Announcer, event: StaffChangedEvent): void {
  room.broadcast(SERVER_MESSAGE.staffChanged, event);
}

/** Registers the hire and fire handlers on a room. */
export function registerStaffHandlers(
  room: Pick<Room<OfficeState>, "onMessage" | "broadcast">,
  host: StaffHost,
): void {
  room.onMessage(CLIENT_MESSAGE.staffHire, (client, raw: unknown) => {
    const payload = parseStaffHireMessage(raw);
    if (payload !== undefined) {
      runStaffCommand(room, host, client, { action: STAFF_ACTION.hire, payload });
    }
  });

  room.onMessage(CLIENT_MESSAGE.staffFire, (client, raw: unknown) => {
    const payload = parseStaffFireMessage(raw);
    if (payload !== undefined) {
      runStaffCommand(room, host, client, { action: STAFF_ACTION.fire, payload });
    }
  });
}
