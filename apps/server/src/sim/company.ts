/**
 * The company clock, as the room's simulation tick runs it.
 *
 * This is the part of the company simulation that needs a room: it measures
 * real time against the room clock, keeps the seconds the schema does not
 * replicate, and summarises the agents' work, the project board's open issues
 * and the payroll when a day ends.
 * What any of that does to the numbers is `@sim/shared`'s `company.ts`, which
 * is also where every tunable lives; nothing here is one.
 *
 * It runs inside the tick, so it is synchronous and cheap by construction. An
 * ordinary step is an addition and a comparison. The work, the board and the
 * staff are read only at midnight, once every in-game day, in one pass each
 * that allocates little beyond the day's report and a set entry per finished
 * issue. The board is the snapshot the feed already holds in memory; reading
 * it waits on nothing.
 */

import { type MapSchema } from "@colyseus/schema";
import {
  type Company,
  type DayReport,
  type IssueWork,
  type Occupant,
  type ProjectBoardSnapshot,
  SECONDS_PER_DAY,
  WORK_STATUS,
  closeDay,
  isTrading,
  payrollOf,
  simSecondsFor,
} from "@sim/shared";

/** The parts of the room a day's close reads and writes. */
export interface CompanyOffice {
  readonly company: Company;
  readonly work: MapSchema<IssueWork>;
  readonly occupants: MapSchema<Occupant>;
  /** The project board as the feed last published it; `undefined` with no feed or before its first poll. */
  readonly board: () => ProjectBoardSnapshot | undefined;
}

/** The room's server-only half of the company clock. */
export interface CompanyClock {
  /** Room clock time of the previous step. */
  lastStepAt: number;
  /** In-game seconds into the current day, which the schema replicates only to the minute. */
  seconds: number;
  /**
   * Issues whose work was already counted as completed, so an issue is
   * credited to the day it was finished and never again. `done` is terminal,
   * so this only grows.
   */
  readonly credited: Set<number>;
}

export function createCompanyClock(company: Company, now: number): CompanyClock {
  return { lastStepAt: now, seconds: company.minuteOfDay * 60, credited: new Set() };
}

/**
 * Advances the clock by however much room time has passed, closing a day at
 * each midnight it crosses.
 *
 * A company that has stopped trading still takes the step, so `lastStepAt` is
 * current, but its clock does not move: the end state is a stopped clock.
 *
 * Payroll is read off whoever is on staff at midnight, so an agent hired
 * during a day is paid from that day's close onwards.
 */
export function stepCompany(office: CompanyOffice, clock: CompanyClock, now: number): void {
  const { company } = office;
  const elapsed = now - clock.lastStepAt;
  clock.lastStepAt = now;
  if (!isTrading(company)) {
    return;
  }

  clock.seconds += simSecondsFor(elapsed);
  // A loop rather than an `if` so the clock stays correct even if the step cap
  // is ever raised past a whole day; at the current tunables it runs at most once.
  while (clock.seconds >= SECONDS_PER_DAY) {
    clock.seconds -= SECONDS_PER_DAY;
    closeDay(company, reportDay(office, clock.credited));
    if (!isTrading(company)) {
      clock.seconds = 0;
      break;
    }
  }

  const minute = Math.floor(clock.seconds / 60);
  if (company.minuteOfDay !== minute) {
    company.minuteOfDay = minute;
  }
}

/**
 * Counts the day's completions in one pass over the work, the issues still to
 * finish, and the payroll.
 *
 * Still to finish is every open issue on the project board less the ones the
 * office has finished, since an issue stays open on GitHub after its work is
 * approved here; and never fewer than the unfinished work in hand, which is
 * all there is to count before the board's first poll.
 */
function reportDay(office: CompanyOffice, credited: Set<number>): DayReport {
  let completedIssues = 0;
  let unfinished = 0;
  const finished = new Set<number>();
  for (const work of office.work.values()) {
    if (work.status !== WORK_STATUS.done) {
      unfinished += 1;
      continue;
    }
    finished.add(work.issueNumber);
    if (!credited.has(work.issueNumber)) {
      credited.add(work.issueNumber);
      completedIssues += 1;
    }
  }

  const board = office.board();
  let openOnBoard = 0;
  if (board !== undefined) {
    openOnBoard = board.counts.open + board.counts.inProgress;
    for (const issue of [...board.open, ...board.inProgress]) {
      if (finished.has(issue.number)) {
        openOnBoard -= 1;
      }
    }
  }
  return {
    completedIssues,
    openIssues: Math.max(unfinished, openOnBoard),
    payroll: payrollOf(office.occupants.values()),
  };
}
