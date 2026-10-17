/**
 * What the runners' real agents have spent today, in US dollars, and how it
 * is said: on the HUD in every tab, in the runner's refusal of a start once
 * its daily budget is spent, and by Firstmate when it explains that refusal.
 *
 * Real money, kept apart from anything in the game: the runner meters it off
 * its agents' transcripts and caps it on its own, and the server only shows
 * what the runners report. Shared so the three say the same thing in the same
 * words.
 */

/**
 * The most a runner may report having spent, or budget for, in a day. Far
 * past any real budget, and small enough that a number the parser takes is
 * always shown as a plain amount.
 */
export const MAX_RUNNER_USD = 1_000_000;

/** What every runner on the floor reported spending today, together. */
export interface RunnerSpendTotal {
  /** Runners reporting; none means there is nothing to show. */
  readonly runners: number;
  readonly spentUsd: number;
  /** The runners' daily budgets added up; `undefined` when any runner has none. */
  readonly budgetUsd: number | undefined;
}

/** No runner reporting. */
export const NO_RUNNER_SPEND: RunnerSpendTotal = { runners: 0, spentUsd: 0, budgetUsd: undefined };

/** `$1.23`. */
export function formatUsd(usd: number): string {
  return `$${(Number.isFinite(usd) ? Math.max(usd, 0) : 0).toFixed(2)}`;
}

/** Whether a day's spend has used up its budget; never, with no budget. */
export function isBudgetSpent(spentUsd: number, budgetUsd: number | undefined): boolean {
  return budgetUsd !== undefined && spentUsd >= budgetUsd;
}

/**
 * Why a runner refuses to start new work, as its failed start says it, or
 * `undefined` while its budget has room.
 */
export function budgetRefusal(spentUsd: number, budgetUsd: number | undefined): string | undefined {
  if (budgetUsd === undefined || !isBudgetSpent(spentUsd, budgetUsd)) {
    return undefined;
  }
  return (
    `The runner's daily budget of ${formatUsd(budgetUsd)} is spent (${formatUsd(spentUsd)} today), ` +
    "so it starts no new work until midnight on its machine"
  );
}

/** The HUD's line: `$1.23 of $5.00 today`, or `$1.23 today, no budget` without one. */
export function spendSummary(total: RunnerSpendTotal): string {
  return total.budgetUsd === undefined
    ? `${formatUsd(total.spentUsd)} today, no budget`
    : `${formatUsd(total.spentUsd)} of ${formatUsd(total.budgetUsd)} today`;
}
