/**
 * The HUD's company readout, and the comparison that decides when it re-renders.
 *
 * The comparison is the part worth pinning: if it ever saw every clock patch as
 * a change, the HUD would re-render several times a second for a clock that
 * only shows quarter hours.
 */

import {
  CLOCK_DISPLAY_STEP_MINUTES,
  COMPANY_STATUS,
  STARTING_CASH,
  STARTING_MINUTE_OF_DAY,
  STARTING_MORALE,
  STARTING_PRODUCTIVITY,
} from "@sim/shared";
import { describe, expect, it } from "vitest";

import { formatCash, formatClock, readCompany, sameReadout } from "./companyReadout.js";
import type { CompanyView } from "./net/room.js";

const OPENING: CompanyView = {
  cash: STARTING_CASH,
  morale: STARTING_MORALE,
  productivity: STARTING_PRODUCTIVITY,
  day: 1,
  minuteOfDay: STARTING_MINUTE_OF_DAY,
  status: COMPANY_STATUS.operating,
};

describe("formatClock", () => {
  it("reads as a 24-hour clock", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(9 * 60)).toBe("09:00");
    expect(formatClock(23 * 60 + 45)).toBe("23:45");
  });

  it("holds each display step until the next one is reached", () => {
    const start = 13 * 60;
    expect(formatClock(start + CLOCK_DISPLAY_STEP_MINUTES - 1)).toBe(formatClock(start));
    expect(formatClock(start + CLOCK_DISPLAY_STEP_MINUTES)).not.toBe(formatClock(start));
  });
});

describe("formatCash", () => {
  it("shows whole currency with separators", () => {
    expect(formatCash(50_000)).toBe("$50,000");
    expect(formatCash(0)).toBe("$0");
  });
});

describe("readCompany", () => {
  it("rounds the scores and flags a bankrupt company", () => {
    const readout = readCompany({
      ...OPENING,
      morale: 41.6,
      productivity: 12.2,
      status: COMPANY_STATUS.bankrupt,
    });
    expect(readout.morale).toBe("42%");
    expect(readout.productivity).toBe("12");
    expect(readout.bankrupt).toBe(true);
  });
});

describe("sameReadout", () => {
  it("ignores clock movement inside a display step", () => {
    const before = readCompany(OPENING);
    const after = readCompany({ ...OPENING, minuteOfDay: OPENING.minuteOfDay + 1 });
    expect(sameReadout(before, after)).toBe(true);
  });

  it("notices a payday, and the first readout", () => {
    const before = readCompany(OPENING);
    expect(sameReadout(before, readCompany({ ...OPENING, cash: OPENING.cash - 1 }))).toBe(false);
    expect(sameReadout(undefined, before)).toBe(false);
  });
});
