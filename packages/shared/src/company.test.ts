/**
 * The day's close is the one place the company's numbers change, so these tests
 * pin what each input does to it, and that the end state is reached and held.
 *
 * They are written against the tunables rather than literal numbers, so a
 * rebalance in `company.ts` does not have to be repeated here.
 */

import { describe, expect, it } from "vitest";

import {
  BACKLOG_TOLERANCE,
  COMPANY_STATUS,
  MAX_CLOCK_STEP_MS,
  METRIC_MAX,
  METRIC_MIN,
  MORALE_DAILY_RECOVERY,
  MORALE_LOSS_PER_EXCESS_TICKET,
  MORALE_LOSS_PER_FIRING,
  PRODUCTIVITY_DAILY_DECAY,
  PRODUCTIVITY_PER_COMPLETED_TICKET,
  QUIT_AFTER_LOW_MORALE_DAYS,
  QUIT_MORALE_THRESHOLD,
  SIM_MINUTES_PER_REAL_SECOND,
  STARTING_CASH,
  STARTING_MINUTE_OF_DAY,
  STARTING_MORALE,
  STARTING_PRODUCTIVITY,
  applyFiringMorale,
  closeDay,
  dailyPayroll,
  isDueToQuit,
  isTrading,
  simSecondsFor,
} from "./company.js";
import { AGENT_ROSTER, DEFAULT_AGENT_COUNT } from "./agents.js";
import { TICK_INTERVAL_MS } from "./constants.js";
import { Company, OfficeState } from "./state.js";

/** What the default office of agents costs a day. */
const PAYROLL = dailyPayroll(
  AGENT_ROSTER.slice(0, DEFAULT_AGENT_COUNT).map((profile) => profile.salary),
);

const QUIET_DAY = { completedTickets: 0, openTickets: BACKLOG_TOLERANCE, payroll: PAYROLL };

/** A day that ends with morale far under the quitting threshold. */
const GRIM_DAY = { ...QUIET_DAY, openTickets: BACKLOG_TOLERANCE + 1_000 };

describe("a new company", () => {
  it("starts from the tunables, trading, on the morning of day 1", () => {
    const { company } = new OfficeState();
    expect(company.cash).toBe(STARTING_CASH);
    expect(company.morale).toBe(STARTING_MORALE);
    expect(company.productivity).toBe(STARTING_PRODUCTIVITY);
    expect(company.day).toBe(1);
    expect(company.minuteOfDay).toBe(STARTING_MINUTE_OF_DAY);
    expect(isTrading(company)).toBe(true);
  });
});

describe("simSecondsFor", () => {
  it("runs the clock at the named ratio", () => {
    expect(simSecondsFor(1000)).toBe(SIM_MINUTES_PER_REAL_SECOND * 60);
  });

  it("credits a whole tick as a whole number of seconds", () => {
    expect(Number.isInteger(simSecondsFor(TICK_INTERVAL_MS))).toBe(true);
  });

  it("credits a stall no more than the cap, and never runs backwards", () => {
    expect(simSecondsFor(60_000)).toBe(simSecondsFor(MAX_CLOCK_STEP_MS));
    expect(simSecondsFor(-500)).toBe(0);
  });
});

describe("closeDay", () => {
  it("advances the day and draws payroll", () => {
    const company = new Company();
    closeDay(company, QUIET_DAY);
    expect(company.day).toBe(2);
    expect(company.cash).toBe(STARTING_CASH - PAYROLL);
  });

  it("raises productivity for each completed ticket, net of the daily decay", () => {
    const company = new Company();
    closeDay(company, { ...QUIET_DAY, completedTickets: 3 });
    expect(company.productivity).toBe(
      STARTING_PRODUCTIVITY + 3 * PRODUCTIVITY_PER_COMPLETED_TICKET - PRODUCTIVITY_DAILY_DECAY,
    );
  });

  it("lets productivity decay on a day nothing was finished", () => {
    const company = new Company();
    closeDay(company, QUIET_DAY);
    expect(company.productivity).toBe(STARTING_PRODUCTIVITY - PRODUCTIVITY_DAILY_DECAY);
  });

  it("erodes morale for every open ticket beyond the tolerated backlog", () => {
    const company = new Company();
    closeDay(company, { ...QUIET_DAY, openTickets: BACKLOG_TOLERANCE + 4 });
    expect(company.morale).toBe(STARTING_MORALE - 4 * MORALE_LOSS_PER_EXCESS_TICKET);
  });

  it("lets morale recover while the backlog is within tolerance", () => {
    const company = new Company();
    closeDay(company, QUIET_DAY);
    expect(company.morale).toBe(STARTING_MORALE + MORALE_DAILY_RECOVERY);
  });

  it("keeps morale and productivity inside their range", () => {
    const company = new Company();
    closeDay(company, { ...GRIM_DAY, completedTickets: 1_000 });
    expect(company.productivity).toBe(METRIC_MAX);
    expect(company.morale).toBe(METRIC_MIN);
  });

  it("goes bankrupt at zero cash instead of running negative", () => {
    const company = new Company();
    company.cash = PAYROLL / 2;
    closeDay(company, QUIET_DAY);
    expect(company.cash).toBe(0);
    expect(company.status).toBe(COMPANY_STATUS.bankrupt);
    expect(isTrading(company)).toBe(false);
  });

  it("treats cash reaching exactly zero as bankrupt", () => {
    const company = new Company();
    company.cash = PAYROLL;
    closeDay(company, QUIET_DAY);
    expect(company.cash).toBe(0);
    expect(company.status).toBe(COMPANY_STATUS.bankrupt);
  });

  it("leaves a bankrupt company exactly as it ended", () => {
    const company = new Company();
    company.cash = PAYROLL;
    closeDay(company, QUIET_DAY);
    const ended = company.toJSON();
    closeDay(company, { completedTickets: 5, openTickets: 50, payroll: PAYROLL });
    expect(company.toJSON()).toEqual(ended);
  });

  it("runs a company that only pays wages out of cash in a known number of days", () => {
    const company = new Company();
    let days = 0;
    while (isTrading(company)) {
      closeDay(company, QUIET_DAY);
      days += 1;
    }
    expect(days).toBe(Math.ceil(STARTING_CASH / PAYROLL));
  });

  it("draws whatever the day's payroll is, so a bigger staff burns cash faster", () => {
    const company = new Company();
    closeDay(company, { ...QUIET_DAY, payroll: PAYROLL * 2 });
    expect(company.cash).toBe(STARTING_CASH - PAYROLL * 2);
  });

  it("counts consecutive days that end with morale under the quitting threshold", () => {
    const company = new Company();
    closeDay(company, GRIM_DAY);
    expect(company.morale).toBeLessThan(QUIT_MORALE_THRESHOLD);
    expect(company.lowMoraleDays).toBe(1);
    closeDay(company, GRIM_DAY);
    expect(company.lowMoraleDays).toBe(2);
  });

  it("starts the count again after a day that ends at or above the threshold", () => {
    const company = new Company();
    company.morale = QUIT_MORALE_THRESHOLD - MORALE_DAILY_RECOVERY - 1;
    company.lowMoraleDays = 2;
    closeDay(company, QUIET_DAY);
    expect(company.lowMoraleDays).toBe(3);
    company.morale = QUIT_MORALE_THRESHOLD;
    closeDay(company, QUIET_DAY);
    expect(company.lowMoraleDays).toBe(0);
  });
});

describe("staffing costs", () => {
  it("adds up every salary, and costs nothing with nobody on staff", () => {
    expect(dailyPayroll([])).toBe(0);
    expect(dailyPayroll([100, 250])).toBe(350);
  });

  it("takes a firing's morale cost at once, and reports what it actually took", () => {
    const company = new Company();
    expect(applyFiringMorale(company)).toBe(MORALE_LOSS_PER_FIRING);
    expect(company.morale).toBe(STARTING_MORALE - MORALE_LOSS_PER_FIRING);

    company.morale = 3;
    expect(applyFiringMorale(company)).toBe(3);
    expect(company.morale).toBe(METRIC_MIN);
  });

  it("is due a quit once the streak reaches its length, and only while trading", () => {
    const company = new Company();
    company.lowMoraleDays = QUIT_AFTER_LOW_MORALE_DAYS - 1;
    expect(isDueToQuit(company)).toBe(false);
    company.lowMoraleDays = QUIT_AFTER_LOW_MORALE_DAYS;
    expect(isDueToQuit(company)).toBe(true);
    company.status = COMPANY_STATUS.bankrupt;
    expect(isDueToQuit(company)).toBe(false);
  });
});
