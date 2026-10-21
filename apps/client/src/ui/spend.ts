/**
 * The roster's line about the runners' spend.
 *
 * Kept out of `./Roster.tsx` because React Fast Refresh only hot-swaps a
 * module whose exports are all components.
 */

import { type RunnerSpendTotal, spendSummary } from "@sim/shared";

/**
 * The runners' books, under the live agents: today's spend against the
 * budget, and once that is spent, that no new work will start. Real money,
 * so it is shown plainly in every tab.
 */
export function spendLine(spend: RunnerSpendTotal): { readonly text: string; readonly spent: boolean } {
  return {
    text: `Agents' spend: ${spendSummary(spend)}${spend.budgetSpent ? " — budget spent, no new starts" : ""}`,
    spent: spend.budgetSpent,
  };
}
