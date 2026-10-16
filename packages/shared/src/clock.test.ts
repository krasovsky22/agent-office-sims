/**
 * The clock is what lights the office, so these tests pin where a room's day
 * starts and the rate it runs at, against the tunables rather than literals.
 */

import { describe, expect, it } from "vitest";

import {
  MAX_CLOCK_STEP_MS,
  SIM_MINUTES_PER_REAL_SECOND,
  STARTING_MINUTE_OF_DAY,
  simSecondsFor,
} from "./clock.js";
import { TICK_INTERVAL_MS } from "./constants.js";
import { OfficeState } from "./state.js";

describe("a new office", () => {
  it("starts its clock at the office opening", () => {
    expect(new OfficeState().minuteOfDay).toBe(STARTING_MINUTE_OF_DAY);
  });
});

describe("simSecondsFor", () => {
  it("runs the clock at the named ratio", () => {
    expect(simSecondsFor(1000)).toBe(SIM_MINUTES_PER_REAL_SECOND * 60);
  });

  it("credits a whole tick as a whole number of seconds", () => {
    expect(Number.isInteger(simSecondsFor(TICK_INTERVAL_MS))).toBe(true);
  });

  it("credits a stall no more than the cap, and never runs backwards", () => {
    expect(simSecondsFor(60_000)).toBe(simSecondsFor(MAX_CLOCK_STEP_MS));
    expect(simSecondsFor(-500)).toBe(0);
  });
});
