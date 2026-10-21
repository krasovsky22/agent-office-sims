/**
 * How real spend is said: the runner's refusal, the HUD's line and the AI Manager's
 * explanation all read these, so their words are pinned here once.
 */

import { describe, expect, it } from "vitest";

import { budgetRefusal, formatUsd, isBudgetSpent, spendSummary, standingSpendText } from "./spend.js";

describe("formatUsd", () => {
  it("shows dollars and cents, and nothing negative or not a number", () => {
    expect(formatUsd(1.234)).toBe("$1.23");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(-2)).toBe("$0.00");
    expect(formatUsd(Number.NaN)).toBe("$0.00");
  });
});

describe("budgetRefusal", () => {
  it("refuses once the day's spend reaches the budget, and not before", () => {
    expect(isBudgetSpent(4.99, 5)).toBe(false);
    expect(budgetRefusal(4.99, 5)).toBeUndefined();
    expect(isBudgetSpent(5, 5)).toBe(true);
    expect(budgetRefusal(5.5, 5)).toBe(
      "The runner's daily budget of $5.00 is spent ($5.50 today), so it starts no new work until midnight on its machine",
    );
  });

  it("never refuses with no budget, and always with a budget of nothing", () => {
    expect(budgetRefusal(1000, undefined)).toBeUndefined();
    expect(budgetRefusal(0, 0)).toBeDefined();
  });
});

describe("standingSpendText", () => {
  it("says the spend against the standing budget, or alone without one", () => {
    expect(standingSpendText(0.11, 2)).toBe("$0.11 of $2.00 today");
    expect(standingSpendText(0.11, undefined)).toBe("$0.11 today");
  });
});

describe("spendSummary", () => {
  it("says the spend against the budget, or that there is none", () => {
    expect(spendSummary({ runners: 1, spentUsd: 1.5, budgetUsd: 5, budgetSpent: false })).toBe("$1.50 of $5.00 today");
    expect(spendSummary({ runners: 2, spentUsd: 0.25, budgetUsd: undefined, budgetSpent: false })).toBe("$0.25 today, no budget");
  });
});
