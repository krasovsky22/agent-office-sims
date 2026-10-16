/**
 * The AI manager: who it is, where it sits, and who it takes instructions from.
 *
 * One manager per office, the Sims-sized version of a fleet supervisor: it
 * keeps track of what every agent is doing, hands the project board's issues
 * out to them, and answers the CEO's questions about all of it. What it says and
 * decides is the server's business (`apps/server/src/manager/`); this module is
 * the part both sides need — the manager's identity and seat, so the server
 * puts it at its desk and the client recognises it, and the one rule about
 * talking to it, so the panel can say why a message would be refused before
 * the server refuses it.
 *
 * The rule is the work's: the CEO runs the office, so only the CEO instructs
 * the manager. Everyone else may read the conversation, which is broadcast,
 * but a message from them is turned away with {@link MANAGER_REJECTION.forbidden}.
 * The manager acts on what the CEO tells it as the CEO would, through the
 * work's own rules with the CEO as the actor, so it gains no authority of its
 * own: it can never do to the work what the CEO who asked could not.
 */

import { INTERACTION_KIND, type InteractableSpec, MANAGER_DESK_ID, type OfficeLayout, interactables } from "./layout.js";
import { ANIMATION_STATE, AiManager, MANAGER_STATUS, normalizeYaw } from "./state.js";
import type { OfficeActor } from "./work.js";

/**
 * The manager's occupant key.
 *
 * Holds a colon, which no Colyseus session id does, so it can never collide
 * with a player's, the same reason a live agent's key carries one.
 */
export const MANAGER_OCCUPANT_ID = "manager:firstmate";

/** What the nameplate and the conversation call it. */
export const MANAGER_NAME = "Firstmate";

export const MANAGER_JOB_TITLE = "AI Manager";

/** Why the manager did not take a message. Refusal never reaches the manager. */
export const MANAGER_REJECTION = {
  /** Only the CEO instructs the manager. */
  forbidden: "forbidden",
  /** It is already working through as many messages as it will queue. */
  busy: "busy",
} as const;

export type ManagerRejection = (typeof MANAGER_REJECTION)[keyof typeof MANAGER_REJECTION];

/**
 * Whether an actor may give the manager instructions. **The one gate.**
 *
 * The server checks it on every message before anything is queued; the client
 * asks it only to disable the composer and say why.
 */
export function mayInstructManager(actor: OfficeActor): boolean {
  return actor.isCeo;
}

const seatCache = new WeakMap<OfficeLayout, InteractableSpec | undefined>();

/** The chair at the manager's desk, or `undefined` for a layout without one. */
export function managerSeat(layout: OfficeLayout): InteractableSpec | undefined {
  if (seatCache.has(layout)) {
    return seatCache.get(layout);
  }
  const seat = interactables(layout).find(
    (spec) => spec.kind === INTERACTION_KIND.seat && spec.deskId === MANAGER_DESK_ID,
  );
  seatCache.set(layout, seat);
  return seat;
}

/**
 * The manager, seated at its desk.
 *
 * Made seated rather than walked there: it never stands up, so there is no
 * arrival worth showing. The caller records the hold, so the chair is taken
 * for everyone else from the first patch.
 *
 * @returns `undefined` for a layout with no manager's desk.
 */
export function employManager(layout: OfficeLayout): AiManager | undefined {
  const seat = managerSeat(layout);
  if (seat === undefined) {
    return undefined;
  }
  const manager = new AiManager();
  manager.id = MANAGER_OCCUPANT_ID;
  manager.name = MANAGER_NAME;
  manager.jobTitle = MANAGER_JOB_TITLE;
  manager.status = MANAGER_STATUS.idle;
  manager.x = seat.anchor.x;
  manager.z = seat.anchor.z;
  manager.yaw = normalizeYaw(seat.anchor.yaw);
  manager.interactableId = seat.id;
  manager.animation = ANIMATION_STATE.sitting;
  return manager;
}
