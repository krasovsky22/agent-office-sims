/**
 * The room's handlers for the lift: the list of floors, and the ride.
 *
 * Thin, like the room's others. Only the room knows where the rider stands,
 * so it is the room that grants a ride: it checks the rider is at a lift and
 * that the floor is another of the building's, then has the building keep the
 * rider a seat there and hands it to them. Nothing here moves anyone: the
 * rider's client takes the seat and leaves this room on purpose, as a closing
 * tab does, and the room's leaving rules do the rest.
 */

import { type Client, type Room } from "@colyseus/core";
import {
  CLIENT_MESSAGE,
  INTERACTION_KIND,
  LIFT_REJECTION,
  type LiftFloor,
  type LiftFloorsEvent,
  type LiftRejectedEvent,
  type LiftRejection,
  type LiftSeatEvent,
  type LiftSeatReservation,
  type Occupant,
  type OfficeLayout,
  type OfficeState,
  SERVER_MESSAGE,
  distanceToInteractable,
  interactables,
  parseLiftFloorsMessage,
  parseLiftRideMessage,
} from "@sim/shared";

import { SERVER_INTERACT_RANGE } from "../sim/interaction.js";

/**
 * How long a rider's seat on the other floor is kept: Colyseus' own seat
 * reservation time. A second ride is refused until then, so a client asking
 * again and again cannot fill a floor with seats nobody takes.
 */
export const RIDE_PENDING_MS = 15_000;

/** What the room needs of the building; see `building.ts`. */
export interface BuildingLifts {
  /** Every floor, ground floor first, with who is on each now. */
  floors(): readonly LiftFloor[];
  /** Keeps a seat on a floor for a rider of this name; `undefined` when every place there is taken. */
  reserve(floor: number, name: string): Promise<LiftSeatReservation | undefined>;
}

/** What the handlers need from the room, named so a test can supply it. */
export interface LiftHandlerHost {
  readonly state: OfficeState;
  /** The floor plan of the room's floor, where its lifts are called. */
  readonly layout: OfficeLayout;
  readonly lifts: BuildingLifts;
  /** Milliseconds, on any clock that only moves forward. */
  readonly now: () => number;
}

function refuse(client: Client, rejection: LiftRejection): void {
  client.send(SERVER_MESSAGE.liftRejected, { rejection } satisfies LiftRejectedEvent);
}

export function registerLiftHandlers(room: Pick<Room<OfficeState>, "onMessage">, host: LiftHandlerHost): void {
  const calls = interactables(host.layout).filter((spec) => spec.kind === INTERACTION_KIND.lift);
  const atLift = (occupant: Occupant): boolean =>
    calls.some((call) => distanceToInteractable(call, occupant) <= SERVER_INTERACT_RANGE);
  // Riders whose seat on another floor is still kept, until when.
  const riding = new Map<string, number>();

  room.onMessage(CLIENT_MESSAGE.liftFloors, (client, raw: unknown) => {
    const sender = host.state.occupants.get(client.sessionId);
    if (parseLiftFloorsMessage(raw) === undefined || sender === undefined) {
      return;
    }
    if (!atLift(sender)) {
      refuse(client, LIFT_REJECTION.outOfRange);
      return;
    }
    client.send(SERVER_MESSAGE.liftFloors, { floors: host.lifts.floors() } satisfies LiftFloorsEvent);
  });

  room.onMessage(CLIENT_MESSAGE.liftRide, async (client, raw: unknown) => {
    const message = parseLiftRideMessage(raw);
    const sender = host.state.occupants.get(client.sessionId);
    if (message === undefined || sender === undefined) {
      return;
    }
    if (!atLift(sender)) {
      refuse(client, LIFT_REJECTION.outOfRange);
      return;
    }
    if (message.floor === host.state.floor) {
      refuse(client, LIFT_REJECTION.sameFloor);
      return;
    }
    if (!host.lifts.floors().some((floor) => floor.floor === message.floor)) {
      refuse(client, LIFT_REJECTION.unknownFloor);
      return;
    }
    const now = host.now();
    for (const [sessionId, until] of riding) {
      if (until <= now) {
        riding.delete(sessionId);
      }
    }
    if (riding.has(client.sessionId)) {
      refuse(client, LIFT_REJECTION.riding);
      return;
    }
    riding.set(client.sessionId, now + RIDE_PENDING_MS);
    const reservation = await host.lifts.reserve(message.floor, sender.name);
    if (reservation === undefined) {
      riding.delete(client.sessionId);
      refuse(client, LIFT_REJECTION.full);
      return;
    }
    client.send(SERVER_MESSAGE.liftSeat, { floor: message.floor, reservation } satisfies LiftSeatEvent);
  });
}
