/**
 * What the HUD says about the lift: each floor's line in its panel, why a
 * ride was refused, and the line the chat log keeps of a ride.
 */

import { LIFT_REJECTION, type LiftFloor, type LiftRejection } from "@sim/shared";

/** A floor in the lift's panel: its number and whose office it is. */
export function floorLabel(floor: number, repository: string | undefined): string {
  return repository === undefined ? `Floor ${floor}` : `Floor ${floor} · ${repository}`;
}

/** Who is on a floor, in words. */
export function headcount(people: number): string {
  return people === 0 ? "nobody there" : people === 1 ? "1 person" : `${people} people`;
}

/** The chat log's line for the player taking the lift to a floor, named if the panel listed it. */
export function rideLine(floor: number, floors: readonly LiftFloor[]): string {
  return `You took the lift to ${floorLabel(floor, floors.find((candidate) => candidate.floor === floor)?.repository)}.`;
}

const REJECTION_TEXT: Readonly<Record<LiftRejection, string>> = {
  [LIFT_REJECTION.outOfRange]: "Walk up to the lift doors to call it.",
  [LIFT_REJECTION.unknownFloor]: "The building has no such floor.",
  [LIFT_REJECTION.sameFloor]: "You are on that floor already.",
  [LIFT_REJECTION.full]: "That floor is full; try again when someone leaves.",
  [LIFT_REJECTION.riding]: "The lift is already on its way.",
};

export function liftRejectionText(rejection: LiftRejection): string {
  return REJECTION_TEXT[rejection];
}
