import { describe, expect, it } from "vitest";

import { floorLabel, headcount, rideLine } from "./lift.js";

describe("the lift's lines", () => {
  it("names a floor by its number and whose office it is", () => {
    expect(floorLabel(2, "acme/site")).toBe("Floor 2 · acme/site");
    expect(floorLabel(3, undefined)).toBe("Floor 3");
  });

  it("counts the people on a floor in words", () => {
    expect([0, 1, 4].map(headcount)).toEqual(["nobody there", "1 person", "4 people"]);
  });

  it("logs a ride with the floor's repository when the panel listed it", () => {
    const floors = [{ floor: 2, repository: "acme/site", people: 0 }];
    expect(rideLine(2, floors)).toBe("You took the lift to Floor 2 · acme/site.");
    expect(rideLine(3, floors)).toBe("You took the lift to Floor 3.");
  });
});
