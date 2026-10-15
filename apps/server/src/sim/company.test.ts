/**
 * The company clock as the room runs it: stepped at the tick rate against real
 * schema state and a project board snapshot, with time passed in rather than
 * read from a clock.
 *
 * What a day does to the numbers is tested in `@sim/shared`; these tests are
 * about when a day ends, what it is told about the work, and that the clock
 * stops with the company.
 */

import {
  BACKLOG_TOLERANCE,
  type BoardIssue,
  COMPANY_STATUS,
  DEFAULT_AGENT_COUNT,
  EMPTY_BOARD_LISTS,
  HIRING_CANDIDATES,
  IssueWork,
  MAX_CLOCK_STEP_MS,
  MINUTES_PER_DAY,
  MORALE_DAILY_RECOVERY,
  MORALE_LOSS_PER_EXCESS_ISSUE,
  OFFICE_LAYOUT,
  OfficeState,
  PRODUCTIVITY_DAILY_DECAY,
  PRODUCTIVITY_PER_COMPLETED_ISSUE,
  type ProjectBoardSnapshot,
  SIM_MINUTES_PER_REAL_SECOND,
  STARTING_CASH,
  STARTING_MINUTE_OF_DAY,
  STARTING_MORALE,
  STARTING_PRODUCTIVITY,
  TICK_INTERVAL_MS,
  WORK_STATUS,
  type WorkStatus,
  employAgent,
  freeAgentDesk,
  payrollOf,
  planHire,
  workKey,
} from "@sim/shared";
import { describe, expect, it } from "vitest";

import { hireAgentEmployees } from "./agents.js";
import { type CompanyClock, type CompanyOffice, createCompanyClock, stepCompany } from "./company.js";

/** Real milliseconds from the starting minute to the first midnight. */
const FIRST_DAY_MS =
  ((MINUTES_PER_DAY - STARTING_MINUTE_OF_DAY) / SIM_MINUTES_PER_REAL_SECOND) * 1000;

/** Real milliseconds in one whole in-game day. */
const DAY_MS = (MINUTES_PER_DAY / SIM_MINUTES_PER_REAL_SECOND) * 1000;

interface Office {
  readonly state: OfficeState;
  readonly clock: CompanyClock;
  readonly view: CompanyOffice;
  board: ProjectBoardSnapshot | undefined;
  now: number;
}

function issue(number: number): BoardIssue {
  return { number, title: `Issue ${number}`, body: "", labels: [], assignees: [], pullRequests: [], closedAt: null };
}

/** A fresh board with `count` open issues, numbered from 1. */
function boardWith(count: number): ProjectBoardSnapshot {
  const open = Array.from({ length: count }, (_, index) => issue(index + 1));
  return {
    ...EMPTY_BOARD_LISTS,
    open,
    counts: { open: count, inProgress: 0, pullRequests: 0 },
    repository: "acme/office",
    updatedAt: 0,
    stale: false,
  };
}

function openOffice(): Office {
  const state = new OfficeState();
  hireAgentEmployees(state.occupants, OFFICE_LAYOUT, DEFAULT_AGENT_COUNT);
  const office: Office = {
    state,
    clock: createCompanyClock(state.company, 0),
    view: { company: state.company, work: state.work, occupants: state.occupants, board: () => office.board },
    board: boardWith(BACKLOG_TOLERANCE),
    now: 0,
  };
  return office;
}

function giveWork(office: Office, issueNumber: number, status: WorkStatus): void {
  const work = new IssueWork();
  work.issueNumber = issueNumber;
  work.status = status;
  work.assigneeId = "agent-1";
  office.state.work.set(workKey(issueNumber), work);
}

/** What the office as it opens costs a day. */
function payroll(office: Office): number {
  return payrollOf(office.state.occupants.values());
}

/** Steps the clock at the room's tick rate for `ms` of real time. */
function run(office: Office, ms: number): void {
  const end = office.now + ms;
  while (office.now < end) {
    office.now = Math.min(office.now + TICK_INTERVAL_MS, end);
    stepCompany(office.view, office.clock, office.now);
  }
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
    expect(office.state.company.cash).toBe(STARTING_CASH - payroll(office));
  });

  it("pays an agent hired during the day from that day's midnight on", () => {
    const office = openOffice();
    const before = payroll(office);
    run(office, FIRST_DAY_MS / 2);

    const candidate = HIRING_CANDIDATES[0];
    const desk = freeAgentDesk(OFFICE_LAYOUT, office.state.occupants.values()).deskId;
    if (candidate === undefined || desk === undefined) {
      throw new Error("no candidate or no free desk");
    }
    const hire = planHire(OFFICE_LAYOUT, office.state.occupants.values(), candidate, desk, 99);
    office.state.occupants.set(hire.id, employAgent(hire));
    expect(office.state.company.cash).toBe(STARTING_CASH);

    run(office, FIRST_DAY_MS / 2);
    expect(office.state.company.day).toBe(2);
    expect(office.state.company.cash).toBe(STARTING_CASH - before - candidate.salary);
  });

  it("credits a finished issue to the day it was finished, once", () => {
    const office = openOffice();
    giveWork(office, 1, WORK_STATUS.done);
    giveWork(office, 2, WORK_STATUS.review);

    run(office, FIRST_DAY_MS);
    const afterFirst =
      STARTING_PRODUCTIVITY + PRODUCTIVITY_PER_COMPLETED_ISSUE - PRODUCTIVITY_DAILY_DECAY;
    expect(office.state.company.productivity).toBe(afterFirst);

    run(office, DAY_MS);
    expect(office.state.company.productivity).toBe(afterFirst - PRODUCTIVITY_DAILY_DECAY);
  });

  it("wears morale down for open issues no one is on beyond the tolerated backlog", () => {
    const office = openOffice();
    office.board = boardWith(BACKLOG_TOLERANCE + 3);
    giveWork(office, 1, WORK_STATUS.in_progress);
    giveWork(office, 2, WORK_STATUS.done);

    run(office, FIRST_DAY_MS);
    expect(office.state.company.morale).toBe(STARTING_MORALE - 2 * MORALE_LOSS_PER_EXCESS_ISSUE);
  });

  it("does not count GitHub's in-progress issues", () => {
    const office = openOffice();
    const board = boardWith(BACKLOG_TOLERANCE);
    office.board = {
      ...board,
      inProgress: [issue(100), issue(101)],
      counts: { ...board.counts, inProgress: 30 },
    };

    run(office, FIRST_DAY_MS);
    expect(office.state.company.morale).toBe(STARTING_MORALE + MORALE_DAILY_RECOVERY);
  });

  it("counts no backlog before the board has loaded", () => {
    const office = openOffice();
    office.board = undefined;
    for (let number = 1; number <= BACKLOG_TOLERANCE + 1; number += 1) {
      giveWork(office, number, WORK_STATUS.in_progress);
    }
    run(office, FIRST_DAY_MS);
    expect(office.state.company.morale).toBe(STARTING_MORALE + MORALE_DAILY_RECOVERY);
  });

  it("does not let a stalled process fast-forward through paydays", () => {
    const office = openOffice();
    office.now += 10 * DAY_MS;
    stepCompany(office.view, office.clock, office.now);
    expect(office.state.company.day).toBe(1);
    expect(office.state.company.minuteOfDay).toBe(
      STARTING_MINUTE_OF_DAY + (MAX_CLOCK_STEP_MS / 1000) * SIM_MINUTES_PER_REAL_SECOND,
    );
  });

  it("stops the clock at midnight when the company runs out of cash", () => {
    const office = openOffice();
    office.state.company.cash = payroll(office);

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
