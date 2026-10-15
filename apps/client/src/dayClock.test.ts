/**
 * The smoothed clock the lighting reads.
 *
 * Pinned because both failure modes are visible: running behind the server
 * steps the sun every patch, and running on without limit lets a stalled or
 * bankrupt company's light keep moving.
 */

import { MINUTES_PER_DAY, SIM_MINUTES_PER_REAL_SECOND } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { DayClock } from "./dayClock.js";

const MS_PER_SIM_MINUTE = 1000 / SIM_MINUTES_PER_REAL_SECOND;

describe("DayClock", () => {
  it("knows no time before the first patch", () => {
    expect(new DayClock().minuteAt(0)).toBeUndefined();
  });

  it("runs on between patches at the server's rate", () => {
    const clock = new DayClock();
    clock.observe(600, true, 1000);
    expect(clock.minuteAt(1000)).toBe(600);
    expect(clock.minuteAt(1000 + MS_PER_SIM_MINUTE / 2)).toBeCloseTo(600.5);
  });

  it("runs no more than a minute past the last patch", () => {
    const clock = new DayClock();
    clock.observe(600, true, 1000);
    expect(clock.minuteAt(1000 + 60_000)).toBe(601);
  });

  it("times the lead from when a minute was first heard, not from every repeat", () => {
    const clock = new DayClock();
    clock.observe(600, true, 1000);
    clock.observe(600, true, 1000 + MS_PER_SIM_MINUTE / 2);
    expect(clock.minuteAt(1000 + MS_PER_SIM_MINUTE / 2)).toBeCloseTo(600.5);
  });

  it("stands still once the company has stopped trading", () => {
    const clock = new DayClock();
    clock.observe(600, false, 1000);
    expect(clock.minuteAt(5000)).toBe(600);
  });

  it("wraps past midnight", () => {
    const clock = new DayClock();
    clock.observe(MINUTES_PER_DAY - 1, true, 0);
    expect(clock.minuteAt(MS_PER_SIM_MINUTE * 0.75)).toBeCloseTo(MINUTES_PER_DAY - 0.25);
    expect(clock.minuteAt(10_000)).toBe(0);
  });
});
