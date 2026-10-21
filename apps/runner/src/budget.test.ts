/**
 * The runner's books: today's spend, the budget that refuses new work once it
 * is spent, and the day turning over.
 */

import { describe, expect, it } from "vitest";

import { SpendLedger, localDay } from "./budget.js";

/** A clock a test moves by hand. */
function clock(start: Date): { now: () => Date; set: (date: Date) => void } {
  let current = start;
  return { now: () => current, set: (date) => (current = date) };
}

describe("SpendLedger", () => {
  it("adds up what is booked and reports it against the budget", () => {
    const ledger = new SpendLedger({ budgetUsd: 5, now: () => new Date(2026, 9, 16, 9) });
    ledger.add(1.25);
    ledger.add(0.5);
    expect(ledger.report()).toEqual({ spentUsd: 1.75, budgetUsd: 5 });
    expect(ledger.refusal()).toBeUndefined();
  });

  it("refuses new work once today's spend reaches the budget", () => {
    const ledger = new SpendLedger({ budgetUsd: 2, now: () => new Date(2026, 9, 16, 9) });
    ledger.add(1.99);
    expect(ledger.refusal()).toBeUndefined();
    ledger.add(0.01);
    expect(ledger.refusal()).toMatch(/^The runner's daily budget of \$2\.00 is spent \(\$2\.00 today\)/);
  });

  it("refuses everything with a budget of nothing, and nothing with no budget", () => {
    expect(new SpendLedger({ budgetUsd: 0 }).refusal()).toBeDefined();
    const unlimited = new SpendLedger({ budgetUsd: undefined });
    unlimited.add(10_000);
    expect(unlimited.refusal()).toBeUndefined();
    expect(unlimited.report()).toEqual({ spentUsd: 10_000, budgetUsd: undefined });
  });

  it("starts a new day at nothing, on the machine's own calendar", () => {
    const time = clock(new Date(2026, 9, 16, 23, 59));
    const ledger = new SpendLedger({ budgetUsd: 1, now: time.now });
    ledger.add(3);
    expect(ledger.refusal()).toBeDefined();
    time.set(new Date(2026, 9, 17, 0, 1));
    expect(ledger.refusal()).toBeUndefined();
    expect(ledger.report().spentUsd).toBe(0);
  });

  it("takes a correction, never below nothing, and ignores what is not a number", () => {
    const ledger = new SpendLedger({ budgetUsd: undefined, now: () => new Date(2026, 9, 16, 9) });
    ledger.add(1);
    ledger.add(-0.25);
    ledger.add(Number.NaN);
    expect(ledger.report().spentUsd).toBe(0.75);
    ledger.add(-5);
    expect(ledger.report().spentUsd).toBe(0);
  });

  it("keeps each slot's share of today's spend, and starts it again with the day", () => {
    const time = clock(new Date(2026, 9, 16, 23, 0));
    const ledger = new SpendLedger({ budgetUsd: undefined, now: time.now });
    ledger.add(1, "slot-1");
    ledger.add(0.5, "slot-2");
    ledger.add(0.25, "slot-1");
    ledger.add(2);
    expect(ledger.slotSpent("slot-1")).toBe(1.25);
    expect(ledger.slotSpent("slot-2")).toBe(0.5);
    expect(ledger.slotSpent("slot-3")).toBe(0);
    expect(ledger.report().spentUsd).toBe(3.75);
    time.set(new Date(2026, 9, 17, 0, 1));
    expect(ledger.slotSpent("slot-1")).toBe(0);
  });
});

describe("localDay", () => {
  it("names the local date", () => {
    expect(localDay(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
  });
});
