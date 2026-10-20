/**
 * The short buffer of poses kept per remote occupant, and the interpolation
 * that reads it back.
 *
 * Pure, so it is tested without a socket: `./room.ts` stamps each sample as it
 * arrives and asks for a pose once a frame, rendered
 * {@link INTERPOLATION_DELAY_MS} behind the present.
 */

import {
  type AnimationState,
  INTERPOLATION_DELAY_MS,
  POSE_BUFFER_SIZE,
  normalizeYaw,
  shortestYawDelta,
} from "@sim/shared";

/** One pose as received, stamped with local arrival time. */
export interface PoseSample {
  t: number;
  x: number;
  z: number;
  yaw: number;
  animation: AnimationState;
}

/** A pose written by {@link samplePoses}. */
export interface RemotePose {
  x: number;
  z: number;
  yaw: number;
  animation: AnimationState;
}

/** Adds a sample, dropping the oldest once the buffer holds {@link POSE_BUFFER_SIZE}. */
export function pushPose(buffer: PoseSample[], sample: PoseSample): void {
  const previous = buffer[buffer.length - 1];
  if (previous !== undefined && previous.t === sample.t) {
    // Two changes decoded in the same frame describe one moment in time.
    buffer[buffer.length - 1] = sample;
    return;
  }
  buffer.push(sample);
  if (buffer.length > POSE_BUFFER_SIZE) {
    buffer.shift();
  }
}

/**
 * Interpolates the buffered poses for the current frame.
 *
 * @param nowMs the frame's timestamp, from the same clock the samples use.
 * @returns whether `out` was written; `false` means nothing has arrived yet.
 */
export function samplePoses(buffer: readonly PoseSample[], nowMs: number, out: RemotePose): boolean {
  const renderTime = nowMs - INTERPOLATION_DELAY_MS;
  const oldest = buffer[0];
  const newest = buffer[buffer.length - 1];
  if (oldest === undefined || newest === undefined) {
    return false;
  }

  // Outside the buffered window there is nothing to interpolate between, so
  // hold the nearest sample rather than extrapolating into a guess.
  if (renderTime <= oldest.t) {
    copySample(oldest, out);
    return true;
  }
  if (renderTime >= newest.t) {
    copySample(newest, out);
    return true;
  }

  for (let i = buffer.length - 1; i > 0; i -= 1) {
    const after = buffer[i];
    const before = buffer[i - 1];
    if (after === undefined || before === undefined || before.t > renderTime) {
      continue;
    }
    const span = after.t - before.t;
    const alpha = span <= 0 ? 1 : (renderTime - before.t) / span;
    out.x = before.x + (after.x - before.x) * alpha;
    out.z = before.z + (after.z - before.z) * alpha;
    out.yaw = normalizeYaw(before.yaw + shortestYawDelta(before.yaw, after.yaw) * alpha);
    out.animation = after.animation;
    return true;
  }

  copySample(newest, out);
  return true;
}

function copySample(sample: PoseSample, out: RemotePose): void {
  out.x = sample.x;
  out.z = sample.z;
  out.yaw = sample.yaw;
  out.animation = sample.animation;
}
