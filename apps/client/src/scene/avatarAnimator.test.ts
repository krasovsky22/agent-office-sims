/**
 * The two pieces of the animator that are arithmetic rather than rendering: how
 * blend weights move, and how fast the walk cycle is played.
 *
 * Both are the acceptance criteria for this part of the renderer written as
 * code. "Transitions blend without snapping" is the claim that no single frame
 * moves a weight all the way, and that the weights always sum to one. "No
 * visible foot sliding" is the claim that playback rate is proportional to
 * ground speed across the whole range a player can legitimately move at.
 */

import { ANIMATION_STATE, SPEED_TOLERANCE, WALK_SPEED } from "@sim/shared";
import { describe, expect, it } from "vitest";

import {
  BLEND_ORDER,
  BLEND_SECONDS,
  WALK_CLIP_GROUND_SPEED,
  advanceBlend,
  walkPlaybackRate,
} from "./avatarAnimator.js";

const FRAME = 1 / 60;

function sum(weights: readonly number[]): number {
  return weights.reduce((total, weight) => total + weight, 0);
}

function idleWeights(): number[] {
  return BLEND_ORDER.map((_unused, index) => (index === 0 ? 1 : 0));
}

describe("BLEND_ORDER", () => {
  it("covers every state the replicated field can carry", () => {
    expect([...BLEND_ORDER].sort()).toEqual(Object.values(ANIMATION_STATE).sort());
  });
});

describe("advanceBlend", () => {
  it("leaves the active state alone once it is the only one playing", () => {
    const weights = idleWeights();
    advanceBlend(weights, 0, FRAME);
    expect(weights).toEqual(idleWeights());
  });

  it("does not hand a state the whole weight in one frame", () => {
    const weights = idleWeights();
    advanceBlend(weights, 1, FRAME);
    expect(weights[1]).toBeGreaterThan(0);
    expect(weights[1]).toBeLessThan(0.5);
    expect(weights[0]).toBeGreaterThan(0.5);
  });

  it("keeps the weights summing to one through a fade", () => {
    const weights = idleWeights();
    for (let elapsed = 0; elapsed < BLEND_SECONDS; elapsed += FRAME) {
      advanceBlend(weights, 1, FRAME);
      expect(sum(weights)).toBeCloseTo(1, 10);
    }
  });

  it("keeps them summing to one when the target changes mid-fade", () => {
    const weights = idleWeights();
    advanceBlend(weights, 1, BLEND_SECONDS / 2);
    advanceBlend(weights, 2, FRAME);
    advanceBlend(weights, 0, FRAME);
    expect(sum(weights)).toBeCloseTo(1, 10);
    for (const weight of weights) {
      expect(weight).toBeGreaterThanOrEqual(0);
    }
  });

  it("completes the fade within the blend window", () => {
    const weights = idleWeights();
    advanceBlend(weights, 2, BLEND_SECONDS);
    expect(weights[2]).toBeCloseTo(1, 10);
    expect(weights[0]).toBeCloseTo(0, 10);
  });

  it("moves monotonically toward the active state", () => {
    const weights = idleWeights();
    let previous = 0;
    for (let elapsed = 0; elapsed < BLEND_SECONDS * 2; elapsed += FRAME) {
      advanceBlend(weights, 3, FRAME);
      const current = weights[3] ?? 0;
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
    expect(previous).toBeCloseTo(1, 10);
  });

  it("settles a long frame straight onto the active state", () => {
    const weights = idleWeights();
    advanceBlend(weights, 1, 10);
    expect(weights[1]).toBeCloseTo(1, 10);
  });

  it("picks the active state out of a cold start rather than leaving nothing playing", () => {
    const weights = BLEND_ORDER.map(() => 0);
    advanceBlend(weights, 2, FRAME);
    expect(sum(weights)).toBeCloseTo(1, 10);
    expect(weights[2]).toBe(1);
  });
});

describe("walkPlaybackRate", () => {
  it("plays the clip at its authored rate at the speed it was authored for", () => {
    expect(walkPlaybackRate(WALK_CLIP_GROUND_SPEED)).toBeCloseTo(1, 10);
  });

  it("scales in proportion to ground speed", () => {
    expect(walkPlaybackRate(WALK_CLIP_GROUND_SPEED * 2)).toBeCloseTo(2, 10);
    expect(walkPlaybackRate(WALK_CLIP_GROUND_SPEED / 2)).toBeCloseTo(0.5, 10);
  });

  it("does not clamp any speed the server would accept", () => {
    const fastest = WALK_SPEED * SPEED_TOLERANCE;
    expect(walkPlaybackRate(fastest)).toBeCloseTo(fastest / WALK_CLIP_GROUND_SPEED, 10);
  });

  it("keeps the cycle turning when the body has already stopped", () => {
    expect(walkPlaybackRate(0)).toBeGreaterThan(0);
  });

  it("survives a speed that is not a number", () => {
    expect(walkPlaybackRate(Number.NaN)).toBe(1);
  });
});
