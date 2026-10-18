/**
 * Cron schedules: read as `cron` reads them, fired on the local clock, and
 * refused when they would fire more often than a paid run should.
 */

import { describe, expect, it } from "vitest";

import { describeCron, nextFire, parseCron, scheduleRefusal, shortestGapMinutes } from "./cron.js";

function schedule(expression: string) {
  const parsed = parseCron(expression);
  if (parsed === undefined) {
    throw new Error(`not a schedule: ${expression}`);
  }
  return parsed;
}

describe("parseCron", () => {
  it("reads numbers, ranges, steps, lists and names", () => {
    const parsed = schedule("*/15 9-17 * jan-mar mon-fri");
    expect([...parsed.minutes]).toEqual([0, 15, 30, 45]);
    expect([...parsed.hours]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...parsed.months]).toEqual([1, 2, 3]);
    expect([...parsed.daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
    expect(parsed.dayOfWeekRestricted).toBe(true);
    expect(parsed.dayOfMonthRestricted).toBe(false);
  });

  it("reads 7 as Sunday, as 0 is", () => {
    expect([...schedule("0 9 * * 7").daysOfWeek]).toEqual([0]);
  });

  it("refuses anything that is not five fields of cron, or never fires", () => {
    for (const bad of ["", "* * * *", "* * * * * *", "60 * * * *", "0 24 * * *", "0 0 32 * *", "0 0 * 13 *", "@daily", "0 9 30 2 *", "*/0 * * * *", "5-1 * * * *", 42]) {
      expect(parseCron(bad)).toBeUndefined();
    }
  });
});

describe("nextFire", () => {
  it("is the next matching minute on the local clock, strictly after the one given", () => {
    const weekdays = schedule("0 9 * * 1-5");
    // Friday 2026-10-16 at 09:00 exactly, so the next is Monday's.
    expect(nextFire(weekdays, new Date(2026, 9, 16, 9, 0, 0))).toEqual(new Date(2026, 9, 19, 9, 0));
    expect(nextFire(weekdays, new Date(2026, 9, 16, 8, 59, 30))).toEqual(new Date(2026, 9, 16, 9, 0));
    expect(nextFire(schedule("*/30 * * * *"), new Date(2026, 9, 18, 10, 7))).toEqual(new Date(2026, 9, 18, 10, 30));
  });

  it("fires on either restricted day field, as cron does", () => {
    // The 1st, or any Monday: Saturday 2026-10-31 is followed by Sunday the 1st.
    expect(nextFire(schedule("0 0 1 * 1"), new Date(2026, 9, 30, 12))).toEqual(new Date(2026, 10, 1, 0, 0));
    expect(nextFire(schedule("0 0 1 * 1"), new Date(2026, 9, 24, 12))).toEqual(new Date(2026, 9, 26, 0, 0));
  });

  it("finds a leap day", () => {
    expect(nextFire(schedule("0 12 29 2 *"), new Date(2026, 0, 1))).toEqual(new Date(2028, 1, 29, 12, 0));
  });
});

describe("how often a schedule may fire", () => {
  it("measures the shortest gap, across the hour too", () => {
    expect(shortestGapMinutes(schedule("*/30 * * * *"))).toBe(30);
    expect(shortestGapMinutes(schedule("0,58 * * * *"))).toBe(2);
    expect(shortestGapMinutes(schedule("55 9,10 * * *"))).toBe(60);
    expect(shortestGapMinutes(schedule("0 9 * * *"))).toBe(24 * 60);
  });

  it("refuses one that fires more often than every five minutes", () => {
    expect(scheduleRefusal("*/5 * * * *")).toBeUndefined();
    expect(scheduleRefusal("*/4 * * * *")).toMatch(/more often than every 5 minutes/);
    expect(scheduleRefusal("* 9 * * *")).toMatch(/more often/);
    expect(scheduleRefusal("nonsense")).toMatch(/not a five-field cron schedule/);
  });
});

describe("describeCron", () => {
  it("says the common shapes in a few words", () => {
    expect(describeCron(schedule("*/30 * * * *"))).toBe("every 30 min");
    expect(describeCron(schedule("0 * * * *"))).toBe("hourly");
    expect(describeCron(schedule("15 * * * *"))).toBe("hourly at :15");
    expect(describeCron(schedule("0 */2 * * *"))).toBe("every 2 h at :00");
    expect(describeCron(schedule("0 9 * * 1-5"))).toBe("weekdays 09:00");
    expect(describeCron(schedule("30 17 * * *"))).toBe("daily 17:30");
    expect(describeCron(schedule("0 10 * * sat,sun"))).toBe("weekends 10:00");
    expect(describeCron(schedule("0 9 * * mon"))).toBe("Mondays 09:00");
    expect(describeCron(schedule("0 9 1 * *"))).toBe("0 9 1 * *");
  });
});
