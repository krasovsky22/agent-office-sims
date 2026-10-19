/**
 * The doors' swing: open for whoever comes near, away from them, and shut
 * again once nobody is.
 */

import { OFFICE_LAYOUT, doorwayGaps } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { DOOR_OPEN_ANGLE, DOOR_OPEN_RADIUS, doorwayLocal, nearestSideOf, swingDoor } from "./doors.js";

/** Swings a door for `seconds` in small frames, as the render loop would. */
function swingFor(angle: number, side: number | undefined, seconds: number): number {
  let next = angle;
  for (let elapsed = 0; elapsed < seconds; elapsed += 1 / 60) {
    next = swingDoor(next, side, 1 / 60);
  }
  return next;
}

describe("swingDoor", () => {
  it("opens away from whoever comes near, all the way, within a second", () => {
    expect(swingFor(0, -0.8, 1)).toBeCloseTo(-DOOR_OPEN_ANGLE);
    expect(swingFor(0, 0.8, 1)).toBeCloseTo(DOOR_OPEN_ANGLE);
  });

  it("keeps opening the way it already is when someone on the other side comes near", () => {
    const opening = swingFor(0, -0.8, 0.1);
    expect(opening).toBeLessThan(0);
    expect(swingFor(opening, 0.8, 1)).toBeCloseTo(-DOOR_OPEN_ANGLE);
  });

  it("closes once nobody is near, and stays shut", () => {
    expect(swingFor(DOOR_OPEN_ANGLE, undefined, 1)).toBe(0);
    expect(swingDoor(0, undefined, 1 / 60)).toBe(0);
  });
});

describe("a doorway's frame", () => {
  const gaps = doorwayGaps(OFFICE_LAYOUT);
  const office = gaps.find((gap) => gap.yaw === 0)!;
  const turned = gaps.find((gap) => gap.yaw !== 0)!;

  it("measures along the gap and across its wall, whichever way the wall runs", () => {
    expect(doorwayLocal(office, { x: office.x + 0.3, z: office.z - 0.5 }).along).toBeCloseTo(0.3);
    expect(doorwayLocal(office, { x: office.x + 0.3, z: office.z - 0.5 }).across).toBeCloseTo(-0.5);
    expect(Math.abs(doorwayLocal(turned, { x: turned.x + 0.5, z: turned.z }).across)).toBeCloseTo(0.5);
    expect(doorwayLocal(turned, { x: turned.x + 0.5, z: turned.z }).along).toBeCloseTo(0);
  });

  it("opens for the nearest body in reach and ignores anyone further off", () => {
    const near = { x: office.x, z: office.z + 0.6 };
    const nearer = { x: office.x, z: office.z - 0.4 };
    const far = { x: office.x, z: office.z + DOOR_OPEN_RADIUS + 0.1 };
    expect(nearestSideOf(office, [near, nearer, far])).toBeCloseTo(-0.4);
    expect(nearestSideOf(office, [far])).toBeUndefined();
    expect(nearestSideOf(office, [])).toBeUndefined();
  });
});
