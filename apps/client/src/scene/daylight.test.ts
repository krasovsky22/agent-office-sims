/**
 * The day's light curve.
 *
 * What the issue asks of it is checkable without a renderer: the light never
 * jumps from one moment to the next, including across midnight and at the
 * sun-moon handover; the sun never drops below the floor's horizon; and no hour
 * is dark enough to lose a room.
 */

import { MINUTES_PER_DAY } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { type Daylight, createDaylight, sampleDaylight } from "./daylight.js";

/** A tenth of a minute: finer than any frame of a two-minute day. */
const STEP = 0.1;

function sample(minute: number): Daylight {
  return sampleDaylight(minute, createDaylight());
}

/** Largest change in anything the light shows between two samples. */
function difference(a: Daylight, b: Daylight): number {
  return Math.max(
    Math.abs(a.sunIntensity - b.sunIntensity),
    Math.abs(a.skyIntensity - b.skyIntensity),
    Math.abs(a.interior - b.interior),
    a.sunDirection.distanceTo(b.sunDirection) * a.sunIntensity,
    Math.abs(a.sunColour.r - b.sunColour.r) * a.sunIntensity,
    Math.abs(a.skyColour.r - b.skyColour.r),
    Math.abs(a.background.b - b.background.b),
  );
}

describe("sampleDaylight", () => {
  it("never jumps between neighbouring moments, midnight included", () => {
    let previous = sample(0);
    for (let minute = STEP; minute <= MINUTES_PER_DAY; minute += STEP) {
      const current = sample(minute);
      expect(difference(previous, current)).toBeLessThan(0.01);
      previous = current;
    }
  });

  it("keeps the directional light above the horizon all day and night", () => {
    for (let minute = 0; minute < MINUTES_PER_DAY; minute += 5) {
      const light = sample(minute);
      expect(light.sunDirection.length()).toBeCloseTo(1);
      expect(light.sunDirection.y).toBeGreaterThan(0.3);
    }
  });

  it("swings the sun from one side of the office to the other over the day", () => {
    expect(sample(7 * 60).sunDirection.x).toBeGreaterThan(0.5);
    expect(sample(17 * 60).sunDirection.x).toBeLessThan(-0.5);
    expect(sample(12 * 60).sunDirection.y).toBeGreaterThan(sample(8 * 60).sunDirection.y);
  });

  it("is bright by day with the interior lights off, and lit from inside by night", () => {
    const noon = sample(12 * 60);
    expect(noon.interior).toBe(0);
    expect(noon.sunIntensity).toBeGreaterThan(1);

    const small = sample(3 * 60);
    expect(small.interior).toBe(1);
    expect(small.sunIntensity).toBeLessThan(noon.sunIntensity / 2);
  });

  it("leaves no hour dark enough to lose a room", () => {
    for (let minute = 0; minute < MINUTES_PER_DAY; minute += 5) {
      const light = sample(minute);
      expect(light.skyIntensity).toBeGreaterThanOrEqual(0.6);
      // Whatever the sun is not giving, the interior lights are.
      expect(light.sunIntensity + light.interior).toBeGreaterThan(0.6);
    }
  });

  it("wraps minutes outside the day", () => {
    expect(sample(-60).sunIntensity).toBeCloseTo(sample(23 * 60).sunIntensity);
    expect(sample(MINUTES_PER_DAY + 60).sunIntensity).toBeCloseTo(sample(60).sunIntensity);
  });

  it("refills the light it is given instead of making another", () => {
    const light = createDaylight();
    const direction = light.sunDirection;
    expect(sampleDaylight(600, light)).toBe(light);
    expect(light.sunDirection).toBe(direction);
  });
});
