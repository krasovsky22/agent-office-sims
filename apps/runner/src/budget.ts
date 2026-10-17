// Adapted from agent-office (MIT, Copyright (c) 2026 AgentSystemLabs): src/server/usage.ts. See THIRD_PARTY_NOTICES.md.
/**
 * The runner's books: what its agents have spent today, in US dollars, and
 * whether its daily budget lets another task start.
 *
 * Real agents cost real money, so the runner caps it itself rather than
 * trusting the game server to: once today's spend reaches
 * `RUNNER_DAILY_BUDGET_USD`, every new start is refused, with the reason, until
 * the day turns over. Work already under way runs on, since stopping an agent
 * halfway loses what it has done; only new work waits.
 *
 * A day is the runner's machine's local day, and spend lands on the day it is
 * read. The books live in memory only: a restarted runner starts the day at
 * nothing.
 */

import { type RunnerSpendReport, budgetRefusal } from "@sim/shared";

/** `2026-10-16`, on the machine's own calendar. */
export function localDay(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export interface SpendLedgerOptions {
  /** `undefined` for no budget: spend is still counted, and nothing is refused. */
  readonly budgetUsd: number | undefined;
  /** Injected so a test controls the day. */
  readonly now?: () => Date;
}

export class SpendLedger {
  private day: string;
  private spent = 0;
  private readonly now: () => Date;

  public constructor(private readonly options: SpendLedgerOptions) {
    this.now = options.now ?? (() => new Date());
    this.day = localDay(this.now());
  }

  /** Books spend on today. A negative amount is a correction to what was booked before. */
  public add(usd: number): void {
    if (!Number.isFinite(usd) || usd === 0) {
      return;
    }
    this.rollOver();
    this.spent = Math.max(this.spent + usd, 0);
  }

  /** Today's spend against the budget, as a sync reports it. */
  public report(): RunnerSpendReport {
    this.rollOver();
    return { spentUsd: this.spent, budgetUsd: this.options.budgetUsd };
  }

  /** Why a new task may not start, or `undefined` while the budget has room. */
  public refusal(): string | undefined {
    this.rollOver();
    return budgetRefusal(this.spent, this.options.budgetUsd);
  }

  /** A new day starts with nothing spent. */
  private rollOver(): void {
    const today = localDay(this.now());
    if (today !== this.day) {
      this.day = today;
      this.spent = 0;
    }
  }
}
