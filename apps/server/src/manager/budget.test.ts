/**
 * The budget is the thing standing between a misbehaving planner loop and an
 * unbounded bill, so its claims are about refusing: that it stops at each
 * limit, says which one and until when, and that only the daily one refills.
 */

import { describe, expect, it } from "vitest";

import { CallBudget } from "./budget.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOON = 20_000 * DAY_MS + DAY_MS / 2;

describe("CallBudget", () => {
  it("spends calls until the daily limit, then refuses until midnight UTC", () => {
    const budget = new CallBudget({ perDay: 2, perRun: 10 }, () => NOON);
    expect(budget.take().ok).toBe(true);
    expect(budget.take().ok).toBe(true);
    const refused = budget.take();
    expect(refused).toMatchObject({ ok: false, retryAt: 20_001 * DAY_MS });
    expect(refused.ok === false && refused.message).toMatch(/today/);
  });

  it("refills the daily limit on a new day", () => {
    let now = NOON;
    const budget = new CallBudget({ perDay: 1, perRun: 10 }, () => now);
    expect(budget.take().ok).toBe(true);
    expect(budget.take().ok).toBe(false);
    now += DAY_MS;
    expect(budget.take().ok).toBe(true);
  });

  it("never refills the per-run limit, whatever the day", () => {
    let now = NOON;
    const budget = new CallBudget({ perDay: 5, perRun: 1 }, () => now);
    expect(budget.take().ok).toBe(true);
    now += DAY_MS;
    const refused = budget.take();
    expect(refused).toMatchObject({ ok: false, retryAt: undefined });
    expect(refused.ok === false && refused.message).toMatch(/run/);
  });

  it("allows nothing at zero", () => {
    expect(new CallBudget({ perDay: 0, perRun: 0 }, () => NOON).take().ok).toBe(false);
  });
});
