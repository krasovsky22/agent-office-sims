/**
 * Which display name a player may have: one nobody else in the office holds.
 *
 * Names carry the game — the concierge's welcome, "Only the CEO, Dana, can…",
 * `Dana → Maya: …` — so two players both called Dana, or a player called
 * "AI Manager" whose chat reads like the manager's, would be misleading. The
 * server asks {@link nameRefusal} when a player renames and
 * {@link arrivalName} when one joins; names are compared ignoring case, since
 * "dana" and "Dana" read as the same person.
 */

import { truncate } from "./text.js";
import { MAX_NAME_LENGTH } from "./messages.js";
import { OCCUPANT_KIND, type OccupantKind } from "./state.js";

export const NAME_REJECTION = {
  /** Another player in the office has it. */
  taken: "taken",
  /** The AI manager, the concierge or a coding agent has it. */
  reserved: "reserved",
} as const;

export type NameRejection = (typeof NAME_REJECTION)[keyof typeof NAME_REJECTION];

/** Someone in the office whose name a player's must not repeat. */
export interface NamedOccupant {
  readonly name: string;
  readonly kind: OccupantKind;
}

/** Why `name` cannot be a player's while `others` are in the office, or `undefined` when it is free. */
export function nameRefusal(name: string, others: Iterable<NamedOccupant>): NameRejection | undefined {
  const key = name.toLowerCase();
  for (const other of others) {
    if (other.name.toLowerCase() === key) {
      return other.kind === OCCUPANT_KIND.human ? NAME_REJECTION.taken : NAME_REJECTION.reserved;
    }
  }
  return undefined;
}

/**
 * The name a joining player gets: the one asked for when it is free, else the
 * first free numbered variant of it ("Dana 2"). A name the manager, the
 * concierge or an agent holds is not varied, since "AI Manager 2" would still
 * read as the manager; nor is no name at all. Both start from `fallback`.
 */
export function arrivalName(requested: string | undefined, fallback: string, others: Iterable<NamedOccupant>): string {
  const present = [...others];
  const base =
    requested === undefined || nameRefusal(requested, present) === NAME_REJECTION.reserved ? fallback : requested;
  let candidate = base;
  for (let n = 2; nameRefusal(candidate, present) !== undefined; n += 1) {
    const suffix = ` ${n}`;
    candidate = `${truncate(base, MAX_NAME_LENGTH - suffix.length).trimEnd()}${suffix}`;
  }
  return candidate;
}
