/**
 * The company clock, as the room's simulation tick runs it.
 *
 * This is the part of the company simulation that needs a room: it measures
 * real time against the room clock, keeps the seconds the schema does not
 * replicate, and summarises the ticket board when a day ends. What any
 * of that does to the numbers is `@sim/shared`'s `company.ts`, which is also
 * where every tunable lives; nothing here is one.
 *
 * It runs inside the tick, so it is synchronous and cheap by construction. An
 * ordinary step is an addition and a comparison. The board is read only at
 * midnight, once every in-game day, in a single pass that allocates nothing but
 * the day's two-number report and a set entry per newly finished ticket.
 */

import { type MapSchema } from "@colyseus/schema";
import {
  type Company,
  SECONDS_PER_DAY,
  TICKET_STATUS,
  type Ticket,
  closeDay,
  isTrading,
  simSecondsFor,
} from "@sim/shared";

/** The room's server-only half of the company clock. */
export interface CompanyClock {
  /** Room clock time of the previous step. */
  lastStepAt: number;
  /** In-game seconds into the current day, which the schema replicates only to the minute. */
  seconds: number;
  /**
   * Tickets already counted as completed, so a ticket is credited to the day it
   * was finished and never again. `done` is terminal, so this only grows.
   */
  readonly credited: Set<string>;
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
 */
export function stepCompany(
  company: Company,
  clock: CompanyClock,
  board: MapSchema<Ticket>,
  now: number,
): void {
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
    closeDay(company, reportDay(board, clock.credited));
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

/** Counts the day's completions and the open work, in one pass over the board. */
function reportDay(board: MapSchema<Ticket>, credited: Set<string>) {
  let completedTickets = 0;
  let openTickets = 0;
  for (const ticket of board.values()) {
    if (ticket.status !== TICKET_STATUS.done) {
      openTickets += 1;
    } else if (!credited.has(ticket.id)) {
      credited.add(ticket.id);
      completedTickets += 1;
    }
  }
  return { completedTickets, openTickets };
}
