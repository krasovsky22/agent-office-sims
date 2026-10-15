/**
 * The ceiling on how many model calls the office may make.
 *
 * A model call costs money, and an agent that keeps failing a ticket keeps
 * trying it, so spend has to be capped by something that does not depend on
 * the caller behaving. Two limits, both counted in calls rather than tokens
 * because a call is what the executor can refuse before it is made:
 *
 * - **Per day**, a UTC calendar day, so a busy afternoon cannot spend the week.
 * - **Per run**, the lifetime of this server process, so a server left up for
 *   a month has a total it will not pass however the days fall.
 *
 * Both counters live in memory. A restart resets them, which makes the per-run
 * limit exactly what it says; the per-day limit is a rate, not an audit, and a
 * deployment that restarts many times a day should lower it accordingly.
 *
 * A call is counted when it is made, not when it succeeds: a timed-out or
 * failed request may still have been billed, and a retry is another call.
 */

export interface CallBudgetLimits {
  readonly perDay: number;
  readonly perRun: number;
}

/** Whether one more call may be made, and if not, why and until when. */
export type BudgetDecision =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly message: string;
      /** Epoch milliseconds the budget refills, or `undefined` when only a restart refills it. */
      readonly retryAt: number | undefined;
    };

const DAY_MS = 24 * 60 * 60 * 1000;

export class CallBudget {
  private day: number;
  private usedToday = 0;
  private usedThisRun = 0;

  public constructor(
    private readonly limits: CallBudgetLimits,
    /** Epoch milliseconds. Injected so a test controls the clock. */
    private readonly now: () => number = Date.now,
  ) {
    this.day = Math.floor(now() / DAY_MS);
  }

  /** Spends one call if there is one to spend; never spends on a refusal. */
  public take(): BudgetDecision {
    this.rollDay();
    if (this.usedThisRun >= this.limits.perRun) {
      return {
        ok: false,
        message: `agent call budget for this server run is spent (${this.limits.perRun} calls); it refills on restart`,
        retryAt: undefined,
      };
    }
    if (this.usedToday >= this.limits.perDay) {
      return {
        ok: false,
        message: `agent call budget for today is spent (${this.limits.perDay} calls); it refills at 00:00 UTC`,
        retryAt: (this.day + 1) * DAY_MS,
      };
    }
    this.usedToday += 1;
    this.usedThisRun += 1;
    return { ok: true };
  }

  /** Calls left before each limit refuses. */
  public remaining(): { readonly today: number; readonly run: number } {
    this.rollDay();
    return {
      today: Math.max(0, this.limits.perDay - this.usedToday),
      run: Math.max(0, this.limits.perRun - this.usedThisRun),
    };
  }

  private rollDay(): void {
    const day = Math.floor(this.now() / DAY_MS);
    if (day !== this.day) {
      this.day = day;
      this.usedToday = 0;
    }
  }
}
