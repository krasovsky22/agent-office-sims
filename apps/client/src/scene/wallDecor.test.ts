/**
 * The wall clocks' hands: the one part of the decor that moves, and the one
 * that has to agree with the office's clock.
 */

import { describe, expect, it } from "vitest";

import { clockHandAngles } from "./wallDecor.js";

describe("clockHandAngles", () => {
  it("points both hands at twelve at noon and midnight", () => {
    for (const minute of [0, 12 * 60]) {
      expect(clockHandAngles(minute).hour).toBeCloseTo(0);
      expect(clockHandAngles(minute).minute).toBeCloseTo(0);
    }
  });

  it("points the hour hand at three and the minute hand at six at half past three", () => {
    const angles = clockHandAngles(15 * 60 + 30);
    expect(angles.hour).toBeCloseTo(((3.5 / 12) * Math.PI * 2));
    expect(angles.minute).toBeCloseTo(Math.PI);
  });

  it("wraps a minute past the end of the day round to the next", () => {
    expect(clockHandAngles(24 * 60 + 90)).toEqual(clockHandAngles(90));
  });
});
