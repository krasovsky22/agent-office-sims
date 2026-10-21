/**
 * The building's floors and the lift between them.
 *
 * Each floor is one repository's office and its own room on the server, so
 * riding the lift is changing rooms: the room the rider is in checks they
 * stand at a lift, reserves them a seat in the floor they chose, and hands the
 * reservation back for the client to take. That keeps the ride
 * server-decided, like every other interaction, and needs nothing of the room
 * being left but the check.
 *
 * Floor 1 is the ground floor, with the street, the lobby and reception; its
 * room keeps the name the client has always joined, so a building of one
 * floor is the office as it always was.
 */

import { OFFICE_ROOM_NAME } from "./messages.js";
import { asRecord } from "./text.js";

/** Most floors one building has, the ground floor included. */
export const MAX_FLOORS = 8;

/** The matchmaking name of a floor's room. */
export function floorRoomName(floor: number): string {
  return floor === 1 ? OFFICE_ROOM_NAME : `${OFFICE_ROOM_NAME}-${floor}`;
}

/** One floor as the lift's panel lists it. */
export interface LiftFloor {
  readonly floor: number;
  /** The repository whose office the floor is, `owner/name`. */
  readonly repository: string;
  /** Players on the floor, its agents and staff not counted. */
  readonly people: number;
}

/** Sent only to the client that called the lift, with every floor. */
export interface LiftFloorsEvent {
  readonly floors: readonly LiftFloor[];
}

/** Asks for the building's floors, from beside a lift; no payload. */
export type LiftFloorsMessage = Readonly<Record<string, never>>;

/** Validates a raw `lift:floors` payload: an object, whose fields are ignored. */
export function parseLiftFloorsMessage(raw: unknown): LiftFloorsMessage | undefined {
  return asRecord(raw) === undefined ? undefined : {};
}

export interface LiftRideMessage {
  readonly floor: number;
}

/** Validates a raw `lift:ride` payload: a floor number the building could have. */
export function parseLiftRideMessage(raw: unknown): LiftRideMessage | undefined {
  const floor = asRecord(raw)?.["floor"];
  return typeof floor === "number" && Number.isInteger(floor) && floor >= 1 && floor <= MAX_FLOORS ? { floor } : undefined;
}

/**
 * A seat kept for the rider in another floor's room: what the client library
 * needs to take it, and nothing else of the server's listing.
 */
export interface LiftSeatReservation {
  readonly sessionId: string;
  readonly room: { readonly name: string; readonly roomId: string; readonly processId: string };
}

/** Sent only to the rider: the seat to take on the floor they chose. */
export interface LiftSeatEvent {
  readonly floor: number;
  readonly reservation: LiftSeatReservation;
}

export const LIFT_REJECTION = {
  /** The rider is not standing at a lift. */
  outOfRange: "out-of-range",
  /** The building has no such floor. */
  unknownFloor: "unknown-floor",
  /** The rider is on that floor already. */
  sameFloor: "same-floor",
  /** Every place on that floor is taken. */
  full: "full",
  /** The rider's last ride has not arrived yet. */
  riding: "riding",
} as const;

export type LiftRejection = (typeof LIFT_REJECTION)[keyof typeof LIFT_REJECTION];

/** Sent only to the client whose ride the lift refused; they stay where they are. */
export interface LiftRejectedEvent {
  readonly rejection: LiftRejection;
}
