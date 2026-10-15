/**
 * The company clock as the room runs it: stepped at the tick rate against real
 * schema state and a seeded board, with time passed in rather than read from a
 * clock.
 *
 * What a day does to the numbers is tested in `@sim/shared`; these tests are
 * about when a day ends, what it is told about the board, and that the clock
 * stops with the company.
 */

import {
  COMPANY_STATUS,
  DAILY_PAYROLL,
  MAX_CLOCK_STEP_MS,
  MINUTES_PER_DAY,
  OfficeState,
  PRODUCTIVITY_DAILY_DECAY,
  PRODUCTIVITY_PER_COMPLETED_TICKET,
  SIM_MINUTES_PER_REAL_SECOND,
  STARTING_CASH,
  STARTING_MINUTE_OF_DAY,
  STARTING_PRODUCTIVITY,
  TICK_INTERVAL_MS,
  TICKET_STATUS,
  type Ticket,
  seedBoard,
} from "@sim/shared";
import { describe, expect, it } from "vitest";

import { type CompanyClock, createCompanyClock, stepCompany } from "./company.js";

/** Real milliseconds from the starting minute to the first midnight. */
const FIRST_DAY_MS =
  ((MINUTES_PER_DAY - STARTING_MINUTE_OF_DAY) / SIM_MINUTES_PER_REAL_SECOND) * 1000;

/** Real milliseconds in one whole in-game day. */
const DAY_MS = (MINUTES_PER_DAY / SIM_MINUTES_PER_REAL_SECOND) * 1000;

interface Office {
  readonly state: OfficeState;
  readonly clock: CompanyClock;
  now: number;
}

function openOffice(): Office {
  const state = new OfficeState();
  let next = 1;
  seedBoard(state.tickets, 0, () => `ticket-${next++}`);
  return { state, clock: createCompanyClock(state.company, 0), now: 0 };
}

/** Steps the clock at the room's tick rate for `ms` of real time. */
function run(office: Office, ms: number): void {
  const end = office.now + ms;
  while (office.now < end) {
    office.now = Math.min(office.now + TICK_INTERVAL_MS, end);
    stepCompany(office.state.company, office.clock, office.state.tickets, office.now);
  }
}

function firstTicket(office: Office): Ticket {
  const ticket = office.state.tickets.values().next().value;
  if (ticket === undefined) {
    throw new Error("the seeded board is empty");
  }
  return ticket;
}

describe("stepCompany", () => {
  it("moves the replicated clock at the named ratio", () => {
    const office = openOffice();
    run(office, 10_000);
    expect(office.state.company.minuteOfDay).toBe(
      STARTING_MINUTE_OF_DAY + 10 * SIM_MINUTES_PER_REAL_SECOND,
    );
    expect(office.state.company.day).toBe(1);
  });

  it("closes the day at midnight, and only then", () => {
    const office = openOffice();
    run(office, FIRST_DAY_MS - TICK_INTERVAL_MS);
    expect(office.state.company.day).toBe(1);
    expect(office.state.company.cash).toBe(STARTING_CASH);

    run(office, TICK_INTERVAL_MS);
    expect(office.state.company.day).toBe(2);
    expect(office.state.company.minuteOfDay).toBe(0);
    expect(office.state.company.cash).toBe(STARTING_CASH - DAILY_PAYROLL);
  });

  it("credits a finished ticket to the day it was finished, once", () => {
    const office = openOffice();
    firstTicket(office).status = TICKET_STATUS.done;

    run(office, FIRST_DAY_MS);
    const afterFirst =
      STARTING_PRODUCTIVITY + PRODUCTIVITY_PER_COMPLETED_TICKET - PRODUCTIVITY_DAILY_DECAY;
    expect(office.state.company.productivity).toBe(afterFirst);

    run(office, DAY_MS);
    expect(office.state.company.productivity).toBe(afterFirst - PRODUCTIVITY_DAILY_DECAY);
  });

  it("does not let a stalled process fast-forward through paydays", () => {
    const office = openOffice();
    office.now += 10 * DAY_MS;
    stepCompany(office.state.company, office.clock, office.state.tickets, office.now);
    expect(office.state.company.day).toBe(1);
    expect(office.state.company.minuteOfDay).toBe(
      STARTING_MINUTE_OF_DAY + (MAX_CLOCK_STEP_MS / 1000) * SIM_MINUTES_PER_REAL_SECOND,
    );
  });

  it("stops the clock at midnight when the company runs out of cash", () => {
    const office = openOffice();
    office.state.company.cash = DAILY_PAYROLL;

    run(office, FIRST_DAY_MS);
    const { company } = office.state;
    expect(company.status).toBe(COMPANY_STATUS.bankrupt);
    expect(company.cash).toBe(0);
    expect(company.day).toBe(2);
    expect(company.minuteOfDay).toBe(0);

    run(office, 3 * DAY_MS);
    expect(company.day).toBe(2);
    expect(company.minuteOfDay).toBe(0);
    expect(company.cash).toBe(0);
  });
});
