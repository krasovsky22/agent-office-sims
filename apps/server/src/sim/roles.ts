/**
 * Who holds the CEO role.
 *
 * The role is what makes the board's authority rules mean anything, so the
 * room must never be in a state where two players hold it or where players are
 * present and nobody does. Both of those are decided here and nowhere else:
 * the room calls {@link roleForArrival} as a player joins,
 * {@link appointSuccessor} after one leaves, and {@link takeCeoRole} when one
 * verifies as operator, and writes no role itself.
 *
 * Each call reads and writes the occupants map synchronously, inside a single
 * message or leave handler. Colyseus encodes a patch only between handlers, so
 * a departure and the promotion that follows it reach every client in the same
 * patch — there is no frame in which a client could see the office without a
 * CEO, or with the old one and the new one at once.
 */

import { type MapSchema } from "@colyseus/schema";
import {
  type HumanPlayer,
  type Occupant,
  PLAYER_ROLE,
  type PlayerRole,
  isCeo,
  isHumanPlayer,
} from "@sim/shared";

/** The player holding the role, if anyone does. */
export function findCeo(occupants: MapSchema<Occupant>): HumanPlayer | undefined {
  for (const occupant of occupants.values()) {
    if (isHumanPlayer(occupant) && isCeo(occupant)) {
      return occupant;
    }
  }
  return undefined;
}

/**
 * The role a player joining now should hold.
 *
 * CEO only if nobody holds it, which in practice means the first to join an
 * empty office. A CEO who has dropped and is inside the reconnection grace
 * period still holds it, so a newcomer arriving in that window joins as an
 * executive rather than becoming a second CEO.
 */
export function roleForArrival(occupants: MapSchema<Occupant>): PlayerRole {
  return findCeo(occupants) === undefined ? PLAYER_ROLE.ceo : PLAYER_ROLE.exec;
}

/**
 * Promotes the longest-connected player if the office has no CEO.
 *
 * A player whose socket has dropped, and whose place is only being held for
 * reconnection, cannot run the board and would not hear the announcement, so
 * they are passed over for anyone still connected. They take the role only
 * when nobody connected is left, so the office still has someone in charge.
 *
 * Called after a departure has been removed from the map. A no-op when someone
 * still holds the role — an executive leaving changes nothing — or when nobody
 * human is left to hold it, in which case the next arrival takes it through
 * {@link roleForArrival}.
 *
 * @param joinedAtOf when each occupant joined, by session id; the earliest
 * wins. An occupant with no known join time ranks last rather than first, so a
 * gap in the bookkeeping cannot jump someone the queue.
 * @param isHeld whether an occupant is inside the reconnection grace period.
 * @returns the player promoted, so the room can announce it, or `undefined`
 * if nobody was.
 */
export function appointSuccessor(
  occupants: MapSchema<Occupant>,
  joinedAtOf: (sessionId: string) => number | undefined,
  isHeld: (sessionId: string) => boolean,
): HumanPlayer | undefined {
  if (findCeo(occupants) !== undefined) {
    return undefined;
  }

  let successor: HumanPlayer | undefined;
  let successorJoinedAt = Number.POSITIVE_INFINITY;
  let successorHeld = true;
  for (const [sessionId, occupant] of occupants) {
    if (!isHumanPlayer(occupant)) {
      continue;
    }
    const joinedAt = joinedAtOf(sessionId) ?? Number.POSITIVE_INFINITY;
    const held = isHeld(sessionId);
    const ranksAhead =
      held === successorHeld ? joinedAt < successorJoinedAt : successorHeld;
    if (successor === undefined || ranksAhead) {
      successor = occupant;
      successorJoinedAt = joinedAt;
      successorHeld = held;
    }
  }

  if (successor !== undefined) {
    successor.role = PLAYER_ROLE.ceo;
  }
  return successor;
}

/**
 * Hands the role to a player who has just verified as operator.
 *
 * The operator is who the server's owner says runs the real agents, so they
 * take the role from whoever holds it, and that player stays on as an
 * executive. The demotion and the promotion are one synchronous call, so no
 * patch shows two CEOs or none.
 *
 * @returns the player who held the role, so the room can announce the change,
 * or `undefined` when `player` already held it.
 */
export function takeCeoRole(occupants: MapSchema<Occupant>, player: HumanPlayer): HumanPlayer | undefined {
  const previous = findCeo(occupants);
  if (previous === player) {
    return undefined;
  }
  if (previous !== undefined) {
    previous.role = PLAYER_ROLE.exec;
  }
  player.role = PLAYER_ROLE.ceo;
  return previous;
}

/**
 * Checks the one invariant this module exists to keep.
 *
 * Exported for tests, in the spirit of `describeBoardProblems`.
 */
export function describeRoleProblems(occupants: MapSchema<Occupant>): string[] {
  const humans = [...occupants.values()].filter(isHumanPlayer);
  const ceos = humans.filter(isCeo);
  if (humans.length > 0 && ceos.length !== 1) {
    return [`${humans.length} players and ${ceos.length} CEOs`];
  }
  return [];
}
