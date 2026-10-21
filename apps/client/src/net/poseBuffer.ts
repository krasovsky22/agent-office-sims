/**
 * The short buffer of poses kept per remote occupant, and the interpolation
 * that reads it back.
 *
 * Pure, so it is tested without a socket: `./room.ts` stamps each sample as it
 * arrives and asks for a pose once a frame, rendered
 * {@link INTERPOLATION_DELAY_MS} behind the present.
 */

import {
  ANIMATION_STATE,
  type AnimationState,
  INTERPOLATION_DELAY_MS,
  POSE_BUFFER_SIZE,
  POSE_SEND_INTERVAL_MS,
  normalizeYaw,
  shortestYawDelta,
} from "@sim/shared";

/** One pose as received, stamped with local arrival time re-spaced by {@link pushPose}. */
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

/** Each buffer's latest real arrival time, since stored stamps may sit later than it. */
const lastArrival = new WeakMap<PoseSample[], number>();

/**
 * Adds a sample stamped with its arrival time, dropping the oldest once the
 * buffer holds {@link POSE_BUFFER_SIZE}.
 *
 * Arrival times carry the network's jitter, so the stored stamp is re-spaced:
 * bunched arrivals spread back out to at least half the send cadence, and the
 * first sample after standing still interpolates over one send interval
 * rather than the whole idle period.
 */
export function pushPose(buffer: PoseSample[], sample: PoseSample): void {
  const arrival = sample.t;
  const previous = buffer[buffer.length - 1];
  if (previous !== undefined && lastArrival.get(buffer) === arrival) {
    // Two changes decoded in the same frame describe one moment in time.
    buffer[buffer.length - 1] = { ...sample, t: previous.t };
    return;
  }
  lastArrival.set(buffer, arrival);
  if (previous !== undefined) {
    // A late packet mid-walk is no standing start; holding there would freeze the walk.
    if (previous.animation !== ANIMATION_STATE.walking && arrival - previous.t > 2 * POSE_SEND_INTERVAL_MS) {
      append(buffer, { ...previous, t: arrival - POSE_SEND_INTERVAL_MS });
    } else {
      sample = { ...sample, t: Math.max(arrival, previous.t + POSE_SEND_INTERVAL_MS * 0.5) };
    }
  }
  append(buffer, sample);
}

function append(buffer: PoseSample[], sample: PoseSample): void {
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
