/**
 * The city round the office: there is one, and none of it stands where
 * somebody walks or something drives.
 */

import { OFFICE_LAYOUT, type Aabb2, groundExtent } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { skylineOf } from "./skyline.js";

function overlaps(a: Aabb2, b: Aabb2): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minZ < b.maxZ && b.minZ < a.maxZ;
}

describe("skylineOf", () => {
  const street = OFFICE_LAYOUT.street;
  if (street === undefined) {
    throw new Error("the shipped layout has no street");
  }
  const buildings = skylineOf(OFFICE_LAYOUT);

  it("lines both sides of the street with brick and glass, some of it tall", () => {
    expect(buildings.some((building) => building.minX >= street.road.maxX)).toBe(true);
    expect(buildings.some((building) => building.maxX <= street.road.minX)).toBe(true);
    expect(new Set(buildings.map((building) => building.style))).toEqual(new Set(["brick", "glass"]));
    expect(Math.max(...buildings.map((building) => building.height))).toBeGreaterThan(60);
  });

  it("keeps every building off the road, the pavements, the office and each other", () => {
    const road = street.road;
    const farPavement = { minX: road.maxX, minZ: road.minZ, maxX: street.farFrontX, maxZ: road.maxZ };
    const nearPavement = { minX: OFFICE_LAYOUT.floor.maxX, minZ: road.minZ, maxX: road.minX, maxZ: road.maxZ };
    const walkable = groundExtent(OFFICE_LAYOUT);
    buildings.forEach((building, index) => {
      for (const [name, box] of [
        ["road", road],
        ["far pavement", farPavement],
        ["near pavement", nearPavement],
        ["office and its pavement", walkable],
      ] as const) {
        expect(overlaps(building, box), `building ${index} on the ${name}`).toBe(false);
      }
      buildings.forEach((other, otherIndex) => {
        if (otherIndex !== index) {
          expect(overlaps(building, other), `buildings ${index} and ${otherIndex}`).toBe(false);
        }
      });
    });
  });

  it("is the same city every time", () => {
    expect(skylineOf(OFFICE_LAYOUT)).toEqual(buildings);
  });

  it("is empty for a floor with no street", () => {
    expect(skylineOf({ ...OFFICE_LAYOUT, street: undefined })).toEqual([]);
  });
});
