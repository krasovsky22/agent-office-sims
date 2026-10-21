/**
 * What the office's interactables do, and who is allowed to use them.
 *
 * Like `collision.ts`, both sides of the wire import this module unchanged. The
 * client runs {@link authorizeInteract} to decide what its proximity prompt
 * says, and the server runs the same function to decide whether to grant the
 * interaction — so a prompt the player can see is a prompt the server will
 * honour, and there is no second copy of the rule to drift away from the first.
 *
 * The one asymmetry is deliberate and lives in the caller, not here: the server
 * passes a slightly wider range (see `INTERACT_RANGE_TOLERANCE`) because it
 * measures from a pose that trails the client's by a round trip.
 *
 * `layout.ts` says where the interactables are. This module says what they mean:
 * how long an interaction holds you, which animation it puts you in, and what
 * the prompt reads. Those are keyed off {@link InteractionKind} by record rather
 * than by `switch`, so adding a kind is a type error until every rule covers it.
 *
 * It also says when one is there at all. A workstation's screen is only worth
 * walking up to while a live agent is working at it, so until then it is not
 * offered: no prompt, nothing the server will grant, and the seat behind it is
 * what `E` reaches for instead.
 */

import { COFFEE_BREAK_MS } from "./constants.js";
import {
  INTERACTION_KIND,
  type InteractableSpec,
  type InteractionKind,
  type OfficeLayout,
  RECURRING_TASKS_BOARD_ID,
  type Vec2,
  interactables,
} from "./layout.js";
import { isLiveAgentKey } from "./liveAgents.js";
import { ANIMATION_STATE, type AnimationState } from "./state.js";

/**
 * Whether using an interactable holds the occupant at its anchor.
 *
 * A held anchor is an exclusive one: the occupant is standing or sitting in it,
 * so a second occupant cannot be. That is what stops two players sharing a
 * chair. A wall board is not held — it is a glance, not a station — and nor
 * is the manager's desk, where a conversation holds nobody in place, an
 * agent's screen, which anyone may read over its shoulder, or a lift, which
 * anyone may call while someone else is choosing a floor.
 */
const HOLDS_ANCHOR: Record<InteractionKind, boolean> = {
  [INTERACTION_KIND.seat]: true,
  [INTERACTION_KIND.coffee]: true,
  [INTERACTION_KIND.board]: false,
  [INTERACTION_KIND.manager]: false,
  [INTERACTION_KIND.screen]: false,
  [INTERACTION_KIND.radio]: false,
  [INTERACTION_KIND.lift]: false,
};

/** How long a hold lasts on its own; `0` means until the occupant releases it. */
const HOLD_MS: Record<InteractionKind, number> = {
  [INTERACTION_KIND.seat]: 0,
  [INTERACTION_KIND.coffee]: COFFEE_BREAK_MS,
  [INTERACTION_KIND.board]: 0,
  [INTERACTION_KIND.manager]: 0,
  [INTERACTION_KIND.screen]: 0,
  [INTERACTION_KIND.radio]: 0,
  [INTERACTION_KIND.lift]: 0,
};

/**
 * The state a held occupant is replicated in.
 *
 * A coffee break stands idle: the avatar rig has no drinking clip, so the
 * break is shown by the cup the client hands anyone held at the machine, which
 * it reads off the replicated `interactableId` and then `coffeeSips` rather
 * than off this field.
 */
const HELD_ANIMATION: Record<InteractionKind, AnimationState> = {
  [INTERACTION_KIND.seat]: ANIMATION_STATE.sitting,
  [INTERACTION_KIND.coffee]: ANIMATION_STATE.idle,
  [INTERACTION_KIND.board]: ANIMATION_STATE.idle,
  [INTERACTION_KIND.manager]: ANIMATION_STATE.idle,
  [INTERACTION_KIND.screen]: ANIMATION_STATE.idle,
  [INTERACTION_KIND.radio]: ANIMATION_STATE.idle,
  [INTERACTION_KIND.lift]: ANIMATION_STATE.idle,
};

/** What the proximity prompt reads. Names the action, not the object. */
const PROMPT: Record<InteractionKind, string> = {
  [INTERACTION_KIND.seat]: "Sit down",
  [INTERACTION_KIND.coffee]: "Pour a coffee",
  [INTERACTION_KIND.board]: "Read the project board",
  [INTERACTION_KIND.manager]: "Talk to the manager",
  [INTERACTION_KIND.screen]: "Watch the agent's terminal",
  [INTERACTION_KIND.radio]: "Change the radio",
  [INTERACTION_KIND.lift]: "Call the lift",
};

export function holdsAnchor(spec: InteractableSpec): boolean {
  return HOLDS_ANCHOR[spec.kind];
}

export function holdMsFor(spec: InteractableSpec): number {
  return HOLD_MS[spec.kind];
}

export function heldAnimationFor(spec: InteractableSpec): AnimationState {
  return HELD_ANIMATION[spec.kind];
}

export function promptFor(spec: InteractableSpec): string {
  // One board is not the project's: it lists the recurring tasks.
  return spec.id === RECURRING_TASKS_BOARD_ID ? "Read the recurring tasks board" : PROMPT[spec.kind];
}

const byIdCache = new WeakMap<OfficeLayout, ReadonlyMap<string, InteractableSpec>>();

function index(layout: OfficeLayout): ReadonlyMap<string, InteractableSpec> {
  const cached = byIdCache.get(layout);
  if (cached !== undefined) {
    return cached;
  }
  const map = new Map<string, InteractableSpec>();
  for (const spec of interactables(layout)) {
    map.set(spec.id, spec);
  }
  byIdCache.set(layout, map);
  return map;
}

/** The interactable with this id, or `undefined` for an id nothing matches. */
export function interactableById(
  layout: OfficeLayout,
  id: string,
): InteractableSpec | undefined {
  return index(layout).get(id);
}

/**
 * Whether an interactable is there to be used right now.
 *
 * Everything is, except a workstation's screen, which is only while a live
 * agent holds the seat it belongs to. A live agent sits only while it is on a
 * task, so a seated one is a working one.
 *
 * @param holderOf as for {@link authorizeInteract}.
 */
export function isOffered(
  spec: InteractableSpec,
  holderOf: (interactableId: string) => string | undefined,
): boolean {
  if (spec.seatId === undefined) {
    return true;
  }
  const holder = holderOf(spec.seatId);
  return holder !== undefined && isLiveAgentKey(holder);
}

/**
 * Distance from a point to an interactable, measured to its anchor.
 *
 * The anchor rather than the object: it is the point the occupant ends up at,
 * it sits right beside the object, and measuring to it means the prompt appears
 * exactly where walking one more step would put you.
 */
export function distanceToInteractable(spec: InteractableSpec, point: Vec2): number {
  return Math.hypot(spec.anchor.x - point.x, spec.anchor.z - point.z);
}

/**
 * The closest interactable within `range` of a point that is
 * {@link isOffered}, or `undefined`.
 *
 * Ties are broken by layout order, which is stable, so the prompt does not
 * flicker between two equidistant things.
 *
 * @param holderOf as for {@link authorizeInteract}.
 */
export function nearestInteractable(
  layout: OfficeLayout,
  point: Vec2,
  range: number,
  holderOf: (interactableId: string) => string | undefined,
): InteractableSpec | undefined {
  let nearest: InteractableSpec | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const spec of interactables(layout)) {
    const distance = distanceToInteractable(spec, point);
    // Distance first: isOffered scans the occupants.
    if (distance <= range && distance < nearestDistance && isOffered(spec, holderOf)) {
      nearest = spec;
      nearestDistance = distance;
    }
  }

  return nearest;
}

export const INTERACT_REFUSAL = {
  /** No interactable in the layout has that id. */
  unknownTarget: "unknown-target",
  /** The actor is too far from the anchor. */
  outOfRange: "out-of-range",
  /** Another occupant is holding the anchor. */
  occupied: "occupied",
  /** The actor is already engaged and has to release first. */
  alreadyEngaged: "already-engaged",
  /** Nothing is there to use yet: a screen with no live agent working at it. */
  notOffered: "not-offered",
} as const;

export type InteractRefusal = (typeof INTERACT_REFUSAL)[keyof typeof INTERACT_REFUSAL];

export type InteractDecision =
  | { readonly allowed: true; readonly target: InteractableSpec }
  | { readonly allowed: false; readonly refusal: InteractRefusal };

/** The occupant asking to interact, as both sides can describe it. */
export interface InteractActor {
  /** Identity, so holding an anchor yourself is not mistaken for a clash. */
  readonly id: string;
  readonly x: number;
  readonly z: number;
  /** Interactable this actor already holds, or `""` when free. */
  readonly interactableId: string;
}

/**
 * Decides whether an actor may use an interactable.
 *
 * @param range how far the caller is willing to reach. The client passes
 * `INTERACT_RANGE`, so its prompt appears exactly at the documented distance;
 * the server passes that times `INTERACT_RANGE_TOLERANCE`, so a player who
 * pressed the key the moment the prompt appeared is not refused for a packet in
 * flight.
 * @param holderOf the occupant id currently holding an interactable, or
 * `undefined` if it is free. The server reads this from its own bookkeeping and
 * the client from replicated state, which is why it is a callback rather than a
 * map: the two sides store it differently and the rule does not care.
 */
export function authorizeInteract(
  layout: OfficeLayout,
  actor: InteractActor,
  targetId: string,
  range: number,
  holderOf: (interactableId: string) => string | undefined,
): InteractDecision {
  const target = interactableById(layout, targetId);
  if (target === undefined) {
    return { allowed: false, refusal: INTERACT_REFUSAL.unknownTarget };
  }
  if (actor.interactableId !== "") {
    return { allowed: false, refusal: INTERACT_REFUSAL.alreadyEngaged };
  }
  // Range before occupancy, so a modified client reaching for a distant desk is
  // told the same thing whether or not somebody happens to be sitting at it.
  if (distanceToInteractable(target, actor) > range) {
    return { allowed: false, refusal: INTERACT_REFUSAL.outOfRange };
  }
  if (holdsAnchor(target)) {
    const holder = holderOf(target.id);
    if (holder !== undefined && holder !== actor.id) {
      return { allowed: false, refusal: INTERACT_REFUSAL.occupied };
    }
  }
  if (!isOffered(target, holderOf)) {
    return { allowed: false, refusal: INTERACT_REFUSAL.notOffered };
  }
  return { allowed: true, target };
}
