/** How a remote occupant's buffered poses read back between packets. */

import { ANIMATION_STATE, INTERPOLATION_DELAY_MS, POSE_BUFFER_SIZE, POSE_SEND_INTERVAL_MS } from "@sim/shared";
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
  it("replaces the newest sample when the next one arrives in the same frame", () => {
    const buffer = [sample(0, 0)];
    pushPose(buffer, sample(50, 5));
    pushPose(buffer, sample(50, 7));
    expect(buffer.map(({ x }) => x)).toEqual([0, 7]);
  });

  it("spreads bunched arrivals back out to at least half the send cadence", () => {
    const buffer = [sample(0, 0)];
    pushPose(buffer, sample(90, 1));
    pushPose(buffer, sample(95, 2));
    pushPose(buffer, sample(100, 3));
    const half = POSE_SEND_INTERVAL_MS * 0.5;
    expect(buffer.map(({ t }) => t)).toEqual([0, 90, 90 + half, 90 + 2 * half]);
  });

  it("keeps the arrival time once samples arrive at the send cadence", () => {
    const buffer = [sample(0, 0)];
    pushPose(buffer, sample(POSE_SEND_INTERVAL_MS, 1));
    expect(buffer.map(({ t }) => t)).toEqual([0, POSE_SEND_INTERVAL_MS]);
  });

  it("starts a walk after standing still from one send interval back, not from the idle pose's time", () => {
    const buffer = [sample(0, 0)];
    pushPose(buffer, sample(5000, 1));
    expect(buffer.map(({ t, x }) => [t, x])).toEqual([
      [0, 0],
      [5000 - POSE_SEND_INTERVAL_MS, 0],
      [5000, 1],
    ]);
    const out = blank();
    samplePoses(buffer, at(5000 - POSE_SEND_INTERVAL_MS / 2), out);
    expect(out.x).toBeCloseTo(0.5);
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
