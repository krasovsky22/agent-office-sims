/**
 * The company's numbers: where they start, how fast the in-game clock runs,
 * and what one day does to them.
 *
 * Every tunable in the company simulation lives in this module, and so does
 * every formula that reads one — with one exception: what each job pays is
 * listed beside the job itself, in `agents.ts`'s hiring candidates. None of the
 * values are balanced yet — that waits until agents actually work the board —
 * so the point is that rebalancing is an edit to these two files and to nothing
 * else: not the room, not a handler, not the HUD.
 *
 * `state.ts` says what the company *is*; this module says what a day *does* to
 * it, in the same split as `tickets.ts`. The formulas are pure functions of the
 * company and a summary of the day, so they can be tested without a room, and
 * they are synchronous and allocation-free so the simulation tick can run them
 * without waiting on anything. Only the server calls them.
 */

import type { Company } from "./state.js";

/**
 * Whether the company is still trading.
 *
 * A string rather than a boolean for the same reason `ANIMATION_STATE` is:
 * running out of cash is the first way a company can end, not the only one.
 */
export const COMPANY_STATUS = {
  operating: "operating",
  bankrupt: "bankrupt",
} as const;

export type CompanyStatus = (typeof COMPANY_STATUS)[keyof typeof COMPANY_STATUS];

/**
 * In-game minutes that pass per real second: the whole speed of the clock.
 *
 * At 12 a day lasts two real minutes, so a few minutes of play crosses enough
 * midnights for the metrics to be seen moving.
 */
export const SIM_MINUTES_PER_REAL_SECOND = 12;

export const MINUTES_PER_DAY = 24 * 60;

/** Where a new company's clock starts on day 1: the office opening, not midnight. */
export const STARTING_MINUTE_OF_DAY = 9 * 60;

/**
 * Longest stretch of real time the clock will credit to one step.
 *
 * The tick runs every 50ms, so this only matters if the process stalls — a
 * debugger pause, a laptop lid. Without it the first step back would fast-forward
 * through however many paydays the stall spanned and could fold the company in
 * one tick that nobody was there to see.
 */
export const MAX_CLOCK_STEP_MS = 1000;

/**
 * Resolution the HUD shows the clock at.
 *
 * The replicated clock moves a minute every few ticks, which is far faster than
 * anyone can read. Showing it in quarter hours keeps it legible and keeps the
 * HUD from re-rendering many times a second for it.
 */
export const CLOCK_DISPLAY_STEP_MINUTES = 15;

/** Cash a new company starts with, in whole currency units. */
export const STARTING_CASH = 50_000;

/**
 * Company morale lost, at once, when the CEO fires an agent.
 *
 * Applied the moment the agent is let go rather than at the day's close, so the
 * office sees the cost land with the decision.
 */
export const MORALE_LOSS_PER_FIRING = 8;

/** Company morale below which staff start counting days towards quitting. */
export const QUIT_MORALE_THRESHOLD = 30;

/**
 * Consecutive day closes with morale under {@link QUIT_MORALE_THRESHOLD} after
 * which an agent quits.
 *
 * The streak starts again after each departure, so a neglected office loses one
 * agent every few days rather than all of them at one midnight.
 */
export const QUIT_AFTER_LOW_MORALE_DAYS = 3;

/** Floor and ceiling for morale and productivity, which are both 0–100 scores. */
export const METRIC_MIN = 0;
export const METRIC_MAX = 100;

export const STARTING_MORALE = 70;
export const STARTING_PRODUCTIVITY = 50;

/** Productivity gained for each ticket that reached `done` during the day. */
export const PRODUCTIVITY_PER_COMPLETED_TICKET = 5;

/**
 * Productivity lost every day regardless.
 *
 * Without it productivity could only ever climb, and an office that stopped
 * finishing work would keep the score it earned weeks ago.
 */
export const PRODUCTIVITY_DAILY_DECAY = 2;

/**
 * Unfinished tickets the office carries without it weighing on anyone.
 *
 * Set to the size of the starter board, so a fresh company's morale holds
 * steady until the backlog actually grows.
 */
export const BACKLOG_TOLERANCE = 5;

/** Morale lost per day for each unfinished ticket beyond {@link BACKLOG_TOLERANCE}. */
export const MORALE_LOSS_PER_EXCESS_TICKET = 2;

/** Morale regained per day while the backlog is within {@link BACKLOG_TOLERANCE}. */
export const MORALE_DAILY_RECOVERY = 1;

/** What the office looked like when a day ended, which is all a day's close reads. */
export interface DayReport {
  /** Tickets that reached `done` since the previous close. */
  readonly completedTickets: number;
  /** Tickets on the board that are not `done`, whatever column they are in. */
  readonly openTickets: number;
  /** What the day costs: the {@link dailyPayroll} of the staff on the floor at midnight. */
  readonly payroll: number;
}

export const SECONDS_PER_DAY = MINUTES_PER_DAY * 60;

/**
 * In-game seconds that `realMs` of room clock is worth.
 *
 * Seconds rather than minutes so that a whole tick is a whole number of them —
 * 36 at the current ratio — and the clock reaches midnight exactly instead of a
 * float rounding error short of it. The multiplications go first for the same
 * reason. A negative interval, which a monotonic clock should never produce, is
 * worth nothing rather than running the clock backwards.
 */
export function simSecondsFor(realMs: number): number {
  const credited = Math.min(Math.max(realMs, 0), MAX_CLOCK_STEP_MS);
  return (credited * SIM_MINUTES_PER_REAL_SECOND * 60) / 1000;
}

export function isTrading(company: Company): boolean {
  return company.status === COMPANY_STATUS.operating;
}

function clampMetric(value: number): number {
  return Math.min(Math.max(value, METRIC_MIN), METRIC_MAX);
}

/**
 * How much a day's backlog moves morale.
 *
 * Counts unfinished work rather than the `backlog` column alone: assigning a
 * ticket does not make the work go away, so it should not make the office feel
 * better either.
 */
export function moraleChange(openTickets: number): number {
  const excess = openTickets - BACKLOG_TOLERANCE;
  return excess > 0 ? -excess * MORALE_LOSS_PER_EXCESS_TICKET : MORALE_DAILY_RECOVERY;
}

/**
 * What one day of the office costs: the sum of every salary.
 *
 * Takes the salaries rather than the occupants, which `agents.ts`'s
 * `payrollOf` reads them from; this module does not know what an agent is.
 */
export function dailyPayroll(salaries: Iterable<number>): number {
  let total = 0;
  for (const salary of salaries) {
    total += salary;
  }
  return total;
}

/**
 * Takes {@link MORALE_LOSS_PER_FIRING} off the company's morale.
 *
 * @returns how far morale actually fell, which is less than the tunable when it
 * was already near the floor, so an announcement never claims a drop that did
 * not happen.
 */
export function applyFiringMorale(company: Company): number {
  const before = company.morale;
  company.morale = clampMetric(before - MORALE_LOSS_PER_FIRING);
  return before - company.morale;
}

/**
 * Whether the low-morale streak has run long enough for somebody to quit.
 *
 * Read by the room straight after {@link closeDay}, which is what moves the
 * streak; the room picks who goes and resets it.
 */
export function isDueToQuit(company: Company): boolean {
  return isTrading(company) && company.lowMoraleDays >= QUIT_AFTER_LOW_MORALE_DAYS;
}

/** How much a day's finished work moves productivity. */
export function productivityChange(completedTickets: number): number {
  return completedTickets * PRODUCTIVITY_PER_COMPLETED_TICKET - PRODUCTIVITY_DAILY_DECAY;
}

/**
 * Closes the day at midnight and opens the next one.
 *
 * The new day's payroll is drawn first, and a company that cannot meet it is
 * bankrupt: cash stops at zero instead of running negative, and the status
 * change is what stops the clock and puts the end state on every screen. The
 * scores still take the day's report first, so the last day's numbers are the
 * ones the end state shows.
 *
 * The low-morale streak is counted against the morale the day ends on, so a
 * day that dipped under {@link QUIT_MORALE_THRESHOLD} and recovered by midnight
 * does not count, and a day that ends above it starts the count again.
 *
 * Does nothing to a company that has already stopped trading.
 */
export function closeDay(company: Company, report: DayReport): void {
  if (!isTrading(company)) {
    return;
  }
  company.productivity = clampMetric(
    company.productivity + productivityChange(report.completedTickets),
  );
  company.morale = clampMetric(company.morale + moraleChange(report.openTickets));
  company.lowMoraleDays =
    company.morale < QUIT_MORALE_THRESHOLD ? company.lowMoraleDays + 1 : 0;
  company.day += 1;
  company.cash = Math.max(company.cash - report.payroll, 0);
  if (company.cash <= 0) {
    company.status = COMPANY_STATUS.bankrupt;
  }
}
