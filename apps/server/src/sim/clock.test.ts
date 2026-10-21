/**
 * The clock as the rooms run it: stepped at the tick rate against real schema
 * state, with time passed in rather than read from a clock.
 */

import {
  MAX_CLOCK_STEP_MS,
  MINUTES_PER_DAY,
  OfficeState,
  SIM_MINUTES_PER_REAL_SECOND,
  STARTING_MINUTE_OF_DAY,
  TICK_INTERVAL_MS,
} from "@sim/shared";
import { describe, expect, it } from "vitest";

import { type SimClock, createSimClock, stepClock } from "./clock.js";

/** Real milliseconds from the starting minute to the first midnight. */
const FIRST_DAY_MS =
  ((MINUTES_PER_DAY - STARTING_MINUTE_OF_DAY) / SIM_MINUTES_PER_REAL_SECOND) * 1000;

interface Office {
  readonly state: OfficeState;
  readonly clock: SimClock;
  now: number;
}

function openOffice(): Office {
  const state = new OfficeState();
  return { state, clock: createSimClock(0), now: 0 };
}

/** Steps the clock at the room's tick rate for `ms` of real time. */
function run(office: Office, ms: number): void {
  const end = office.now + ms;
  while (office.now < end) {
    office.now = Math.min(office.now + TICK_INTERVAL_MS, end);
    stepClock(office.state, office.clock, office.now);
  }
}

describe("stepClock", () => {
  it("moves the replicated clock at the named ratio", () => {
    const office = openOffice();
    run(office, 10_000);
    expect(office.state.minuteOfDay).toBe(STARTING_MINUTE_OF_DAY + 10 * SIM_MINUTES_PER_REAL_SECOND);
  });

  it("wraps round to midnight and keeps going", () => {
    const office = openOffice();
    run(office, FIRST_DAY_MS - TICK_INTERVAL_MS);
    expect(office.state.minuteOfDay).toBe(MINUTES_PER_DAY - 1);

    run(office, TICK_INTERVAL_MS);
    expect(office.state.minuteOfDay).toBe(0);

    run(office, 10_000);
    expect(office.state.minuteOfDay).toBe(10 * SIM_MINUTES_PER_REAL_SECOND);
  });

  it("does not let a stalled process jump the light forward", () => {
    const office = openOffice();
    office.now += 60 * 60 * 1000;
    stepClock(office.state, office.clock, office.now);
    expect(office.state.minuteOfDay).toBe(
      STARTING_MINUTE_OF_DAY + (MAX_CLOCK_STEP_MS / 1000) * SIM_MINUTES_PER_REAL_SECOND,
    );
  });

  it("is one clock for every floor: a floor opened later shows the time the others do", () => {
    const ground = openOffice();
    run(ground, 10_000);
    const upstairs = new OfficeState();
    stepClock(upstairs, ground.clock, ground.now);
    expect(upstairs.minuteOfDay).toBe(ground.state.minuteOfDay);
  });

  it("moves no further for a second room stepping it at the same moment, or a moment behind", () => {
    const office = openOffice();
    run(office, 10_000);
    const other = new OfficeState();
    stepClock(other, office.clock, office.now);
    stepClock(other, office.clock, office.now - TICK_INTERVAL_MS);
    run(office, 10_000);
    expect(office.state.minuteOfDay).toBe(STARTING_MINUTE_OF_DAY + 20 * SIM_MINUTES_PER_REAL_SECOND);
  });
});
