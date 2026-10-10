/**
 * Playback of one avatar's clips.
 *
 * Two things here are deliberate rather than incidental:
 *
 * - **States blend, they do not cut.** Every clip has an action that is always
 *   playing; what changes is its weight. Each frame the weights move a fixed
 *   fraction of the way toward "all of the active state, none of the others"
 *   and are renormalised, so a state change is a fade of a known length and no
 *   pose ever jumps. {@link advanceBlend} is that arithmetic on its own.
 * - **The walk cycle is played at the speed the avatar is actually moving.**
 *   The clip covers a fixed amount of ground per loop, so playing it at a rate
 *   that does not match the body's speed slides the feet across the floor. The
 *   rate is the ratio of the two; see {@link WALK_CLIP_GROUND_SPEED}.
 */

import {
  ANIMATION_STATE,
  type AnimationState,
  SPEED_TOLERANCE,
  WALK_SPEED,
} from "@sim/shared";
import * as THREE from "three";

import type { AvatarClips } from "./avatarClips.js";

/**
 * How long a state change takes to complete.
 *
 * Short enough that a walk looks like it starts on the keypress, long enough
 * that the limbs visibly travel between the two poses instead of popping.
 */
export const BLEND_SECONDS = 0.18;

/**
 * Ground speed the walk clip covers at playback rate 1, in metres per second.
 *
 * Measured off the shipped asset rather than guessed. With the model scaled to
 * an occupant's height, the planted foot travels backwards at this speed
 * through the stance phase of the cycle, so playing the clip at `speed / this`
 * holds the stance foot still relative to the floor — which is what "the feet
 * do not slide" means. Checked by stepping an avatar at a fixed speed and
 * reading the stance foot's world velocity back off the rig: the residual is a
 * few per cent of the body's, which is smaller than the spread between
 * reasonable definitions of where the stance phase begins, and it stays there
 * from half walking speed up to the fastest pose the server will accept.
 */
export const WALK_CLIP_GROUND_SPEED = 1.19;

/**
 * Floor on walk playback.
 *
 * A walk cycle fading out while the body has already stopped would otherwise
 * freeze mid-stride, which reads as a stutter rather than a stop.
 */
const MIN_WALK_PLAYBACK = 0.3;

/**
 * Ceiling on walk playback, from the fastest pose the server will accept.
 *
 * Above this nothing honest can be moving, so clamping here cannot reintroduce
 * sliding for a real player.
 */
const MAX_WALK_PLAYBACK = (WALK_SPEED * SPEED_TOLERANCE) / WALK_CLIP_GROUND_SPEED;

/** The states, in the order their weights are held in. */
export const BLEND_ORDER: readonly AnimationState[] = [
  ANIMATION_STATE.idle,
  ANIMATION_STATE.walking,
  ANIMATION_STATE.sitting,
  ANIMATION_STATE.typing,
];

/**
 * Moves blend weights one frame toward the active state.
 *
 * Weights are renormalised, so they always sum to one: a mixer fed weights that
 * sum to less than one blends the shortfall in from the bind pose, which during
 * a three-way fade shows up as the avatar briefly going slack.
 *
 * @param weights mutated in place, one entry per {@link BLEND_ORDER} state.
 * @param activeIndex the state being faded in.
 */
export function advanceBlend(weights: number[], activeIndex: number, deltaSeconds: number): void {
  const step = Math.min(1, Math.max(deltaSeconds, 0) / BLEND_SECONDS);
  let total = 0;

  for (let i = 0; i < weights.length; i += 1) {
    const current = weights[i] ?? 0;
    const gap = (i === activeIndex ? 1 : 0) - current;
    const next = Math.abs(gap) <= step ? current + gap : current + Math.sign(gap) * step;
    weights[i] = next;
    total += next;
  }

  if (total <= 0) {
    // Nothing is playing yet, which only happens on the first frame.
    for (let i = 0; i < weights.length; i += 1) {
      weights[i] = i === activeIndex ? 1 : 0;
    }
    return;
  }

  for (let i = 0; i < weights.length; i += 1) {
    weights[i] = (weights[i] ?? 0) / total;
  }
}

/** Playback rate for the walk clip at a given ground speed. */
export function walkPlaybackRate(speedMetresPerSecond: number): number {
  if (!Number.isFinite(speedMetresPerSecond)) {
    return 1;
  }
  const rate = speedMetresPerSecond / WALK_CLIP_GROUND_SPEED;
  return Math.min(MAX_WALK_PLAYBACK, Math.max(MIN_WALK_PLAYBACK, rate));
}

export class AvatarAnimator {
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions: readonly THREE.AnimationAction[];
  private readonly weights: number[];
  private readonly walkIndex = BLEND_ORDER.indexOf(ANIMATION_STATE.walking);

  private activeIndex = Math.max(BLEND_ORDER.indexOf(ANIMATION_STATE.idle), 0);
  private speed = 0;

  public constructor(
    private readonly root: THREE.Object3D,
    clips: AvatarClips,
  ) {
    this.mixer = new THREE.AnimationMixer(root);
    this.actions = BLEND_ORDER.map((state) => {
      const action = this.mixer.clipAction(clips[state]);
      if (isTransition(state)) {
        // The sit-down clip ends in the seated pose, so it is played once and
        // held there rather than looped back to standing.
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      action.enabled = true;
      action.setEffectiveWeight(0);
      action.play();
      return action;
    });
    this.weights = BLEND_ORDER.map((_unused, index) => (index === this.activeIndex ? 1 : 0));
    this.applyWeights();
  }

  /** Starts the fade toward `state`. A repeat of the current state is a no-op. */
  public setState(state: AnimationState): void {
    const next = BLEND_ORDER.indexOf(state);
    if (next < 0 || next === this.activeIndex) {
      return;
    }
    if (isTransition(state)) {
      // A one-shot that has already run is sitting clamped at its end; rewind it
      // so re-entering the state plays the movement again.
      this.actions[next]?.reset();
    }
    this.activeIndex = next;
  }

  /** The body's current horizontal speed, which scales the walk cycle. */
  public setSpeed(metresPerSecond: number): void {
    this.speed = metresPerSecond;
  }

  public update(deltaSeconds: number): void {
    advanceBlend(this.weights, this.activeIndex, deltaSeconds);
    this.applyWeights();
    this.actions[this.walkIndex]?.setEffectiveTimeScale(walkPlaybackRate(this.speed));
    this.mixer.update(deltaSeconds);
  }

  public dispose(): void {
    this.mixer.stopAllAction();
    // Only this body's bindings; the clips themselves are shared with every
    // other avatar and stay cached.
    this.mixer.uncacheRoot(this.root);
  }

  private applyWeights(): void {
    for (let i = 0; i < this.actions.length; i += 1) {
      this.actions[i]?.setEffectiveWeight(this.weights[i] ?? 0);
    }
  }
}

/** Whether a state's clip is a one-shot transition into a pose it then holds. */
function isTransition(state: AnimationState): boolean {
  return state === ANIMATION_STATE.sitting;
}
