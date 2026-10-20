import { OFFICE_LAYOUT } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { roomSigns } from "./office.js";

describe("roomSigns", () => {
  const signs = roomSigns(OFFICE_LAYOUT);

  it("names every room a newcomer walks to, from the open floor or the lobby", () => {
    const outside = signs.filter((sign) => sign.z > -4.85 && sign.x < 4.15).map((sign) => sign.text);
    expect(outside).toEqual(expect.arrayContaining(["CEO Office", "AI Manager's Office", "Conference Room", "Kitchen", "Open Floor"]));
  });

  it("leaves the street door to its canopy", () => {
    expect(signs.map((sign) => sign.text)).not.toContain("Sidewalk");
    expect(signs).toHaveLength((OFFICE_LAYOUT.doorways.length - 1) * 2);
  });

  it("hangs the manager's sign on the open floor side of its door, facing in", () => {
    const sign = signs.find((candidate) => candidate.text === "AI Manager's Office");
    expect(sign).toMatchObject({ x: 2.8, yaw: 0 });
    expect(sign?.z).toBeGreaterThan(-4.85);
    expect(sign?.y).toBeGreaterThan(2.1);
  });

  it("faces the conference room's sign west, out onto the open floor", () => {
    const sign = signs.find((candidate) => candidate.text === "Conference Room");
    expect(sign?.x).toBeLessThan(4.15);
    expect(sign?.yaw).toBeCloseTo(-Math.PI / 2);
  });
});
