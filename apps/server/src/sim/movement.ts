/**
 * Validation of incoming poses.
 *
 * Movement is client-authoritative: a player's own avatar moves the instant
 * they press a key, and the pose that produces is reported here. The server's
 * job is not to re-simulate that movement but to check it is one an honest
 * client could have produced, and to publish the result as the authoritative
 * position other clients see.
 *
 * Two checks do that work, and only two:
 *
 * 1. The implied speed is clamped against the shared walking speed, so a
 *    modified client cannot teleport across the office.
 * 2. The clamped movement goes through the same shared collision resolver the
 *    client used, so a modified client cannot step through a wall.
 *
 * Because the second check runs the identical function the client ran, an honest
 * client's pose survives both unchanged and the player feels no correction.
 */

import {
  MAX_POSE_INTERVAL_MS,
  OCCUPANT_RADIUS,
  type OfficeLayout,
  type Occupant,
  type PoseMessage,
  SPEED_TOLERANCE,
  WALK_SPEED,
  ANIMATION_STATE,
  type AnimationState,
  normalizeYaw,
  resolveMove,
} from "@sim/shared";

/**
 * Per-occupant bookkeeping the server needs but clients do not.
 *
 * Deliberately not part of the replicated schema: nothing here is useful to a
 * renderer, and every replicated field costs bandwidth on every patch.
 */
export interface OccupantMotion {
  /** Latest pose reported by the client, overwritten as newer ones arrive. */
  readonly pending: {
    x: number;
    z: number;
    yaw: number;
    animation: AnimationState;
  };
  /** Whether {@link pending} holds a pose the simulation has not consumed. */
  hasPending: boolean;
  /** Room clock time at which the last accepted pose was applied. */
  lastAppliedAt: number;
  /** Room clock time the last pose message arrived. */
  lastMessageAt: number;
  /** Arrival order, used to decide who inherits the CEO title. */
  readonly joinedAt: number;
}

export function createMotion(x: number, z: number, yaw: number, now: number): OccupantMotion {
  return {
    pending: { x, z, yaw, animation: ANIMATION_STATE.idle },
    hasPending: false,
    lastAppliedAt: now,
    lastMessageAt: now,
    joinedAt: now,
  };
}

/** Records a validated pose message, replacing any pose not yet simulated. */
export function recordPose(motion: OccupantMotion, pose: PoseMessage, now: number): void {
  motion.pending.x = pose.x;
  motion.pending.z = pose.z;
  motion.pending.yaw = pose.yaw;
  motion.pending.animation = pose.animation;
  motion.hasPending = true;
  motion.lastMessageAt = now;
}

/**
 * Writes an occupant's pending pose into the replicated state, clamped and
 * collided.
 *
 * The travel budget is the distance an honest client could have covered since
 * the last pose this occupant had accepted, which is why `lastAppliedAt` only
 * advances when a pose is actually applied: a tick that finds nothing pending
 * leaves the budget to accumulate, so a client whose packet was late is not
 * punished for it. The budget is capped at {@link MAX_POSE_INTERVAL_MS} so that
 * going quiet cannot bank an arbitrarily long jump.
 *
 * Synchronous and allocation-light by design — see the note on the room's
 * simulation interval.
 */
export function applyPose(
  occupant: Occupant,
  motion: OccupantMotion,
  now: number,
  layout: OfficeLayout,
): void {
  const elapsed = Math.min(Math.max(now - motion.lastAppliedAt, 0), MAX_POSE_INTERVAL_MS);
  const budget = (WALK_SPEED * SPEED_TOLERANCE * elapsed) / 1000;

  let deltaX = motion.pending.x - occupant.x;
  let deltaZ = motion.pending.z - occupant.z;
  const requested = Math.hypot(deltaX, deltaZ);
  if (requested > budget && requested > 0) {
    const scale = budget / requested;
    deltaX *= scale;
    deltaZ *= scale;
  }

  const resolved = resolveMove(occupant, { x: deltaX, z: deltaZ }, OCCUPANT_RADIUS, layout);
  occupant.x = resolved.x;
  occupant.z = resolved.z;
  occupant.yaw = normalizeYaw(motion.pending.yaw);
  occupant.animation = motion.pending.animation;
  motion.lastAppliedAt = now;
}
