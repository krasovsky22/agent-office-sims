/**
 * The concierge: the scripted host behind the lobby's reception desk.
 *
 * Not an agent and not a player. It takes no work, holds no runner slot and
 * answers nothing; it stands at its post and welcomes whoever walks into the
 * lobby. What it says and when is the server's (`apps/server/src/sim/concierge.ts`);
 * this module is the part both sides need — who it is and where it stands, so
 * the server places it and the client recognises it, and the words of its
 * welcome, so a test can read them without a room.
 *
 * Its post is derived from the reception desk rather than written down, so
 * moving the desk moves the concierge with it.
 */

import { LOBBY_ROOM_ID, type OfficeLayout, type SpawnSpec, type Vec2, localToWorld, roomAt } from "./layout.js";
import { sanitizeChatText, sanitizeName } from "./messages.js";
import { ANIMATION_STATE, OCCUPANT_KIND, Occupant, normalizeYaw } from "./state.js";

/**
 * The concierge's occupant key.
 *
 * Holds a colon, which no Colyseus session id does, so it can never collide
 * with a player's, the same reason the manager's and a live agent's carry one.
 */
export const CONCIERGE_OCCUPANT_ID = "concierge:reception";

/** What the nameplate and the chat log call it. */
export const CONCIERGE_NAME = "Concierge";

/**
 * How far behind the reception desk's back edge the concierge stands.
 *
 * Half the gap between the desk and the feature wall behind it, so the body
 * reads as standing at the desk rather than leaning on the wall.
 */
const POST_GAP = 0.3;

/**
 * Where the concierge stands: behind the reception desk, facing the way the
 * desk does, which is at the main entrance.
 *
 * A desk faces its local -Z, so its back is local +Z.
 *
 * @returns `undefined` for a layout with no reception desk.
 */
export function conciergePost(layout: OfficeLayout): SpawnSpec | undefined {
  const desk = layout.props.find((spec) => spec.kind === "reception");
  if (desk === undefined) {
    return undefined;
  }
  return { ...localToWorld(desk, desk.yaw, 0, desk.depth / 2 + POST_GAP), yaw: normalizeYaw(desk.yaw) };
}

/**
 * The concierge, standing at its post.
 *
 * Placed rather than walked there, like the manager at its desk: it never
 * leaves, so there is no arrival worth showing.
 *
 * @returns `undefined` for a layout with no reception desk.
 */
export function employConcierge(layout: OfficeLayout): Occupant | undefined {
  const post = conciergePost(layout);
  if (post === undefined) {
    return undefined;
  }
  const concierge = new Occupant();
  concierge.id = CONCIERGE_OCCUPANT_ID;
  concierge.name = CONCIERGE_NAME;
  concierge.kind = OCCUPANT_KIND.concierge;
  concierge.x = post.x;
  concierge.z = post.z;
  concierge.yaw = post.yaw;
  concierge.animation = ANIMATION_STATE.idle;
  return concierge;
}

/**
 * Whether a point is inside the lobby, `undefined` when it is in neither the
 * lobby nor another room: a doorway or a wall, where whoever stands there is
 * still on their way from one room to the next.
 */
export function isInLobby(layout: OfficeLayout, point: Vec2): boolean | undefined {
  const room = roomAt(layout, point);
  return room === undefined ? undefined : room.id === LOBBY_ROOM_ID;
}

/**
 * What the concierge says to someone walking into the lobby.
 *
 * The name is a player's own, already sanitized at join; it goes through the
 * same treatment again, and the line through a chat line's, so the welcome is
 * never something a chat message could not have been.
 */
export function conciergeWelcome(name: string): string {
  const who = sanitizeName(name).trim();
  return sanitizeChatText(
    who === ""
      ? "Welcome to the office! The door left of the lifts takes you in."
      : `Welcome to the office, ${who}! The door left of the lifts takes you in.`,
  );
}
