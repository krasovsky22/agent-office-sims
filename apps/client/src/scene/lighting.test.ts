/**
 * Where the interior lights hang.
 *
 * They come from the layout's rooms, so the thing worth pinning is that every
 * room gets at least one and none ends up outside the room it lights.
 */

import { OFFICE_LAYOUT, containsPoint } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { interiorLightPositions } from "./lighting.js";

describe("interiorLightPositions", () => {
  const positions = interiorLightPositions(OFFICE_LAYOUT);

  it("lights every room", () => {
    for (const room of OFFICE_LAYOUT.rooms) {
      expect(positions.some((p) => containsPoint(room.bounds, { x: p.x, z: p.z }))).toBe(true);
    }
  });

  it("hangs every light inside a room and under the ceiling", () => {
    for (const p of positions) {
      expect(OFFICE_LAYOUT.rooms.some((room) => containsPoint(room.bounds, { x: p.x, z: p.z }))).toBe(true);
      expect(p.y).toBeLessThan(3);
    }
  });

  it("stays to a handful of lights, since each one costs every lit pixel", () => {
    expect(positions.length).toBeLessThanOrEqual(12);
  });
});
