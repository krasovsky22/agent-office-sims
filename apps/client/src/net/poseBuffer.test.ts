/** How a remote occupant's buffered poses read back between packets. */

import { ANIMATION_STATE, INTERPOLATION_DELAY_MS, POSE_BUFFER_SIZE } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { type PoseSample, type RemotePose, pushPose, samplePoses } from "./poseBuffer.js";

const sample = (t: number, x: number, yaw = 0): PoseSample => ({ t, x, z: 0, yaw, animation: ANIMATION_STATE.walking });
const blank = (): RemotePose => ({ x: Number.NaN, z: Number.NaN, yaw: Number.NaN, animation: ANIMATION_STATE.idle });
/** The frame time that renders exactly at `t`. */
const at = (t: number): number => t + INTERPOLATION_DELAY_MS;

describe("samplePoses", () => {
  it("writes nothing before the first pose arrives", () => {
    const out = blank();
    expect(samplePoses([], at(0), out)).toBe(false);
    expect(out.x).toBeNaN();
  });

  it("interpolates between the two samples either side of the render time", () => {
    const out = blank();
    expect(samplePoses([sample(0, 0), sample(100, 10)], at(25), out)).toBe(true);
    expect(out.x).toBeCloseTo(2.5);
    expect(out.animation).toBe(ANIMATION_STATE.walking);
  });

  it("holds the nearest sample outside the buffered window rather than extrapolating", () => {
    const out = blank();
    const buffer = [sample(100, 1), sample(200, 2)];
    samplePoses(buffer, at(50), out);
    expect(out.x).toBe(1);
    samplePoses(buffer, at(500), out);
    expect(out.x).toBe(2);
  });

  it("turns the short way across the wrap from just under pi to just over minus pi", () => {
    const out = blank();
    samplePoses([sample(0, 0, Math.PI - 0.1), sample(100, 0, -Math.PI + 0.1)], at(50), out);
    expect(Math.abs(out.yaw)).toBeCloseTo(Math.PI);
  });

  it("takes the later sample when two share a timestamp", () => {
    const out = blank();
    samplePoses([sample(0, 0), sample(100, 5), sample(100, 7), sample(200, 9)], at(100), out);
    expect(out.x).toBe(7);
  });
});

describe("pushPose", () => {
  it("replaces the newest sample when the next one carries the same timestamp", () => {
    const buffer = [sample(0, 0), sample(100, 5)];
    pushPose(buffer, sample(100, 7));
    expect(buffer.map(({ x }) => x)).toEqual([0, 7]);
  });

  it("keeps only the newest samples once the buffer is full", () => {
    const buffer: PoseSample[] = [];
    for (let i = 0; i < POSE_BUFFER_SIZE + 3; i += 1) {
      pushPose(buffer, sample(i * 50, i));
    }
    expect(buffer).toHaveLength(POSE_BUFFER_SIZE);
    expect(buffer[0]?.x).toBe(3);
  });
});
