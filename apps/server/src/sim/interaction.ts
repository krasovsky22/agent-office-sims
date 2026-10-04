/**
 * Who is holding which interactable, and the three things the room does about
 * it: grant an interact request, let go of a hold, and let a timed hold expire.
 *
 * The authoritative answer to "is that chair taken?" lives here, on the server,
 * and nowhere else. Clients are told the answer through each occupant's
 * replicated `interactableId`, but they are never asked for it: occupancy is
 * exactly the kind of check a modified client would skip.
 *
 * The room's handlers only parse and call in; every decision is made here,
 * against an {@link InteractionHost} the room hands over, which is what lets the
 * range re-check, the occupancy rule and seat release be tested without a
 * socket. Everything is synchronous, so the tick that calls {@link holdTick}
 * never waits on anything.
 */

import {
  ANIMATION_STATE,
  INTERACT_RANGE,
  INTERACT_REFUSAL,
  INTERACT_RANGE_TOLERANCE,
  type InteractDecision,
  type InteractableSpec,
  type Occupant,
  type OfficeLayout,
  authorizeInteract,
  heldAnimationFor,
  holdMsFor,
  holdsAnchor,
  normalizeYaw,
} from "@sim/shared";

import { type OccupantMotion, discardPending } from "./movement.js";

/**
 * How far the server will reach when authorising an interaction.
 *
 * Wider than the range the client prompts at, by exactly the documented
 * tolerance, because this room measures from the last pose it accepted rather
 * than from where the client is now.
 */
export const SERVER_INTERACT_RANGE = INTERACT_RANGE * INTERACT_RANGE_TOLERANCE;

export interface Hold {
  readonly interactableId: string;
  /**
   * Room clock time this hold ends on its own.
   *
   * `Number.POSITIVE_INFINITY` for a hold with no duration, such as a seat: it
   * lasts until the occupant releases it or leaves. Comparing against a number
   * is what keeps the expiry check inside the simulation tick synchronous.
   */
  readonly endsAt: number;
}

/**
 * Two maps rather than one, because both directions are hot. The room asks
 * "what is this session holding?" every tick to decide whether a hold has run
 * out, and "who holds this id?" on every interact message. Deriving either from
 * the other would mean a scan.
 */
export class HoldRegistry {
  private readonly bySession = new Map<string, Hold>();
  private readonly byInteractable = new Map<string, string>();

  /** The session holding an interactable, or `undefined` if it is free. */
  public holderOf(interactableId: string): string | undefined {
    return this.byInteractable.get(interactableId);
  }

  /** What a session is holding, or `undefined` if it is free. */
  public heldBy(sessionId: string): Hold | undefined {
    return this.bySession.get(sessionId);
  }

  /**
   * Records a session taking an interactable.
   *
   * The caller is expected to have authorised it first — this class enforces
   * nothing, it only remembers. Any hold the session already had is dropped, so
   * one session can never appear in two places.
   */
  public take(sessionId: string, spec: InteractableSpec, now: number): Hold {
    this.release(sessionId);
    const duration = holdMsFor(spec);
    const hold: Hold = {
      interactableId: spec.id,
      endsAt: duration <= 0 ? Number.POSITIVE_INFINITY : now + duration,
    };
    this.bySession.set(sessionId, hold);
    this.byInteractable.set(spec.id, sessionId);
    return hold;
  }

  /** Frees whatever a session was holding. Safe to call on a free session. */
  public release(sessionId: string): void {
    const existing = this.bySession.get(sessionId);
    if (existing === undefined) {
      return;
    }
    this.bySession.delete(sessionId);
    // Only clear the reverse entry if it still points at this session, so a
    // stale release cannot evict whoever took the anchor afterwards.
    if (this.byInteractable.get(existing.interactableId) === sessionId) {
      this.byInteractable.delete(existing.interactableId);
    }
  }
}

/** What the interaction rules need from the room, named so a test can supply it. */
export interface InteractionHost {
  readonly layout: OfficeLayout;
  readonly occupants: { get(sessionId: string): Occupant | undefined };
  readonly motions: { get(sessionId: string): OccupantMotion | undefined };
  readonly holds: HoldRegistry;
}

/**
 * What came of an interact request.
 *
 * `used` is an interaction that holds nothing — the whiteboard — and so changes
 * no state; the room decides what trace, if any, it leaves.
 */
export type InteractOutcome =
  | { readonly result: "refused"; readonly decision: InteractDecision }
  | { readonly result: "held"; readonly target: InteractableSpec }
  | { readonly result: "used"; readonly target: InteractableSpec };

/**
 * Decides a client's interact request and applies it, or does nothing at all.
 *
 * "Nothing at all" is the whole point of the refusal branch: a request that
 * fails authorisation leaves the room exactly as it was, so an out-of-range
 * interact from a modified client is not a partial success. Range is measured
 * from the pose this room has accepted, never from anything the client said.
 */
export function requestInteract(
  host: InteractionHost,
  sessionId: string,
  target: string,
  now: number,
): InteractOutcome {
  const occupant = host.occupants.get(sessionId);
  if (occupant === undefined) {
    return { result: "refused", decision: { allowed: false, refusal: INTERACT_REFUSAL.unknownTarget } };
  }

  const decision = authorizeInteract(
    host.layout,
    {
      id: sessionId,
      x: occupant.x,
      z: occupant.z,
      interactableId: occupant.interactableId,
    },
    target,
    SERVER_INTERACT_RANGE,
    (interactableId) => host.holds.holderOf(interactableId),
  );
  if (!decision.allowed) {
    return { result: "refused", decision };
  }

  if (!holdsAnchor(decision.target)) {
    return { result: "used", target: decision.target };
  }

  const spec = decision.target;
  host.holds.take(sessionId, spec, now);
  occupant.interactableId = spec.id;
  occupant.x = spec.anchor.x;
  occupant.z = spec.anchor.z;
  occupant.yaw = normalizeYaw(spec.anchor.yaw);
  occupant.animation = heldAnimationFor(spec);

  const motion = host.motions.get(sessionId);
  if (motion !== undefined) {
    discardPending(motion, now);
  }
  return { result: "held", target: spec };
}

/**
 * Frees whatever an occupant was holding and hands movement back.
 *
 * The occupant is left standing at the anchor rather than moved anywhere: the
 * client resumes predicting from the same point, so standing up costs no
 * correction. Safe to call on an occupant that holds nothing.
 *
 * @returns whether there was a hold to release.
 */
export function releaseHold(host: InteractionHost, sessionId: string, now: number): boolean {
  if (host.holds.heldBy(sessionId) === undefined) {
    return false;
  }
  host.holds.release(sessionId);

  const occupant = host.occupants.get(sessionId);
  if (occupant !== undefined) {
    occupant.interactableId = "";
    occupant.animation = ANIMATION_STATE.idle;
  }

  const motion = host.motions.get(sessionId);
  if (motion !== undefined) {
    discardPending(motion, now);
  }
  return true;
}

/**
 * The tick's view of one occupant's hold.
 *
 * A timed hold that has run out is released here, checked against the clock
 * rather than awaited on a timer. An occupant still held has the pose it is
 * reporting thrown away: the position and animation on the state are the
 * server's, and a pose sent before the hold began must not drag them back out.
 *
 * @returns whether the occupant is still held, in which case the tick must not
 * apply their pose.
 */
export function holdTick(host: InteractionHost, sessionId: string, now: number): boolean {
  const hold = host.holds.heldBy(sessionId);
  if (hold === undefined) {
    return false;
  }
  if (now >= hold.endsAt) {
    releaseHold(host, sessionId, now);
    return false;
  }
  const motion = host.motions.get(sessionId);
  if (motion !== undefined) {
    discardPending(motion, now);
  }
  return true;
}
