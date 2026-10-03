/**
 * Capsule-vs-AABB movement resolution.
 *
 * Both sides of the wire import this module unchanged: the client calls it to
 * predict the local player's step, and the server calls it to validate the pose
 * that step produced. If the two ever resolved differently the player would see
 * the server pull them back on every contact, so there is deliberately no
 * client-only or server-only branch anywhere in here — one pure function of
 * position, desired movement, and layout.
 *
 * Collision is 2D. An occupant is a vertical capsule, which on the ground plane
 * is a circle, and every obstacle is an axis-aligned box.
 */

import {
  COLLISION_SUBSTEP,
  MAX_COLLISION_SUBSTEPS,
} from "./constants.js";
import { type Aabb2, type OfficeLayout, type Vec2, collisionBoxes } from "./layout.js";

/** Mutable point, so callers can resolve into a scratch value. */
export interface MutableVec2 {
  x: number;
  z: number;
}

/**
 * How far short of an obstacle a blocked move comes to rest.
 *
 * Stopping exactly on the contact boundary leaves the circle touching the box,
 * where the next axis test cannot tell contact from overlap. Backing off by a
 * hair keeps every intermediate position strictly outside every box.
 */
const CONTACT_EPSILON = 1e-4;

/**
 * Slack when deciding which side of a box a move starts on.
 *
 * A position produced by an earlier clamp sits a rounding error away from the
 * contact boundary; without this tolerance such a position could read as being
 * inside the box and the obstacle would stop blocking.
 */
const SIDE_EPSILON = 1e-6;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Advances one axis as far as the obstacles allow.
 *
 * `alongX` selects the axis being moved; the other coordinate is held fixed.
 * Both axes run through this one function rather than through a specialised
 * copy each, because the whole point of this module is that there is exactly
 * one resolution rule and no second implementation to drift away from it.
 *
 * For a circle at a fixed `other` coordinate, a box forbids an interval of
 * positions on the moving axis. Inside the box's slab on the fixed axis that
 * interval is the box extent grown by the radius; outside the slab the circle
 * can only catch the corner, which leaves a narrower interval found from the
 * remaining radius. Every obstacle is tested against the original start, so the
 * most restrictive one wins regardless of the order they are visited in.
 */
function sweepAxis(
  from: number,
  to: number,
  other: number,
  radius: number,
  boxes: readonly Aabb2[],
  alongX: boolean,
): number {
  if (to === from) {
    return from;
  }
  const forward = to > from;
  const radiusSq = radius * radius;
  let limit = to;

  for (let i = 0; i < boxes.length; i += 1) {
    const box = boxes[i];
    if (box === undefined) {
      continue;
    }
    const otherMin = alongX ? box.minZ : box.minX;
    const otherMax = alongX ? box.maxZ : box.maxX;
    const gap = other - clamp(other, otherMin, otherMax);
    const slackSq = radiusSq - gap * gap;
    if (slackSq <= 0) {
      // The circle clears this box on the fixed axis no matter where it stops.
      continue;
    }
    const slack = Math.sqrt(slackSq);
    const alongMin = alongX ? box.minX : box.minZ;
    const alongMax = alongX ? box.maxX : box.maxZ;
    const low = alongMin - slack;
    const high = alongMax + slack;

    if (forward) {
      if (from <= low + SIDE_EPSILON) {
        const stop = low - CONTACT_EPSILON;
        if (stop < limit) {
          limit = stop;
        }
      }
    } else if (from >= high - SIDE_EPSILON) {
      const stop = high + CONTACT_EPSILON;
      if (stop > limit) {
        limit = stop;
      }
    }
  }

  // A start position already inside a box produces no constraint above, which
  // lets it escape rather than freeze. Never let a clamp push motion backwards.
  return forward ? Math.max(limit, from) : Math.min(limit, from);
}

/**
 * Resolves a desired movement against the layout.
 *
 * `from` is expected to be finite and not already inside an obstacle, which is
 * what both callers hold: the client starts from a spawn point and only ever
 * advances through this function, and the server starts from the last pose it
 * accepted. A non-finite component of `delta` is treated as no movement on that
 * axis so a malformed message cannot poison a stored position.
 *
 * The move is advanced in substeps of at most {@link COLLISION_SUBSTEP} so that
 * a single large step cannot skip over a thin wall between two tests. Within a
 * substep the axes are resolved one after the other, which is what produces
 * sliding: a move into a wall at an angle loses the component into the surface
 * and keeps the component along it.
 *
 * @returns a fresh position; neither argument is mutated.
 */
export function resolveMove(
  from: Vec2,
  delta: Vec2,
  radius: number,
  layout: OfficeLayout,
): MutableVec2 {
  const deltaX = Number.isFinite(delta.x) ? delta.x : 0;
  const deltaZ = Number.isFinite(delta.z) ? delta.z : 0;
  let x = from.x;
  let z = from.z;

  if (deltaX === 0 && deltaZ === 0) {
    return { x, z };
  }

  const boxes = collisionBoxes(layout);
  const distance = Math.hypot(deltaX, deltaZ);
  const steps = Math.min(
    Math.max(1, Math.ceil(distance / COLLISION_SUBSTEP)),
    MAX_COLLISION_SUBSTEPS,
  );
  const stepX = deltaX / steps;
  const stepZ = deltaZ / steps;

  for (let step = 0; step < steps; step += 1) {
    x = sweepAxis(x, x + stepX, z, radius, boxes, true);
    z = sweepAxis(z, z + stepZ, x, radius, boxes, false);
  }

  // Backstop in case a caller ever starts an occupant outside the shell walls.
  const { floor } = layout;
  x = clamp(x, floor.minX + radius, floor.maxX - radius);
  z = clamp(z, floor.minZ + radius, floor.maxZ - radius);

  return { x, z };
}

/** Whether a circle on the ground plane overlaps a box. */
export function circleOverlapsBox(point: Vec2, radius: number, box: Aabb2): boolean {
  const dx = point.x - clamp(point.x, box.minX, box.maxX);
  const dz = point.z - clamp(point.z, box.minZ, box.maxZ);
  return dx * dx + dz * dz < radius * radius;
}

/** Whether a position would put an occupant inside any obstacle. */
export function isBlocked(point: Vec2, radius: number, layout: OfficeLayout): boolean {
  for (const box of collisionBoxes(layout)) {
    if (circleOverlapsBox(point, radius, box)) {
      return true;
    }
  }
  return false;
}
