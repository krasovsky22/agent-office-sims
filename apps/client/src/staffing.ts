/**
 * What the HUD says about the staff: who may hire and fire, what the payroll
 * comes to, how many desks are left, and what to say when someone joins or
 * leaves.
 *
 * Nothing is decided here. Whether the local player may hire is
 * `mayManageStaff`, the server's own gate, and the payroll is `dailyPayroll`,
 * the rule behind the figure the server draws at midnight; this module only
 * words them, the way `boardAccess.ts` words the ticket board's rule.
 */

import {
  HIRING_CANDIDATES,
  OFFICE_LAYOUT,
  STAFF_CHANGE,
  STAFF_REJECTION,
  type StaffChangedEvent,
  type StaffRejection,
  type TicketActor,
  dailyPayroll,
  mayManageStaff,
  recruitingFee,
} from "@sim/shared";

import { formatCash } from "./companyReadout.js";

/** One job on the hiring list, as shown. */
export interface CandidateReadout {
  readonly id: string;
  readonly jobTitle: string;
  /** e.g. `$600/day`. */
  readonly salary: string;
  /** e.g. `$1,200 to hire`. */
  readonly fee: string;
}

/** The staff as the HUD shows them. */
export interface StaffReadout {
  /** Whether the local player may hire and fire; the server's own rule. */
  readonly canManage: boolean;
  /** e.g. `5 of 8 desks filled`. */
  readonly desks: string;
  /** Whether every agent desk is taken, so the hire buttons can say so. */
  readonly full: boolean;
  /** What the next midnight will draw, e.g. `$2,500/day`. */
  readonly payroll: string;
  readonly candidates: readonly CandidateReadout[];
}

const CANDIDATES: readonly CandidateReadout[] = HIRING_CANDIDATES.map((candidate) => ({
  id: candidate.id,
  jobTitle: candidate.jobTitle,
  salary: `${formatCash(candidate.salary)}/day`,
  fee: `${formatCash(recruitingFee(candidate.salary))} to hire`,
}));

/**
 * The staff readout for the local player, from the salaries of the agents on
 * the floor — one per agent, the one thing the payroll reads.
 */
export function readStaff(actor: TicketActor | undefined, salaries: readonly number[]): StaffReadout {
  const capacity = OFFICE_LAYOUT.agentDesks.length;
  return {
    canManage: actor !== undefined && mayManageStaff(actor),
    desks: `${salaries.length} of ${capacity} desks filled`,
    full: salaries.length >= capacity,
    payroll: `${formatCash(dailyPayroll(salaries))}/day`,
    candidates: CANDIDATES,
  };
}

/** Whether two readouts would put the same thing on screen. */
export function sameStaff(a: StaffReadout | undefined, b: StaffReadout): boolean {
  return (
    a !== undefined &&
    a.canManage === b.canManage &&
    a.desks === b.desks &&
    a.full === b.full &&
    a.payroll === b.payroll
  );
}

const REJECTION_TEXT: Readonly<Record<StaffRejection, string>> = {
  [STAFF_REJECTION.forbidden]: "Only the CEO can hire and fire.",
  [STAFF_REJECTION.notTrading]: "The company has folded; nobody is hiring or firing now.",
  [STAFF_REJECTION.unknownCandidate]: "That job is not on the hiring list.",
  [STAFF_REJECTION.noFreeDesk]:
    "Every agent desk is taken. Fire someone before hiring: the office has no room for more.",
  [STAFF_REJECTION.deskInUse]:
    "The only free desk has someone sitting at it. Hire again once they stand up.",
  [STAFF_REJECTION.cannotAfford]: "There is not enough cash to pay the recruiting fee.",
  [STAFF_REJECTION.unknownAgent]: "That agent is no longer on the staff.",
};

/** What to tell the CEO when the server refuses a hire or a fire. */
export function staffRejectionText(rejection: StaffRejection): string {
  return REJECTION_TEXT[rejection];
}

function ticketsReturned(count: number): string {
  if (count === 0) {
    return "";
  }
  return count === 1
    ? " Their unfinished ticket is back in the backlog."
    : ` Their ${count} unfinished tickets are back in the backlog.`;
}

/** The office's announcement of a staff change, for the chat log. */
export function staffChangeText(event: StaffChangedEvent): string {
  const who = `${event.name} (${event.jobTitle})`;
  switch (event.change) {
    case STAFF_CHANGE.hired:
      return (
        `${who} was hired at ${formatCash(event.salary)}/day, ` +
        `for a ${formatCash(event.fee)} recruiting fee.`
      );
    case STAFF_CHANGE.fired:
      return (
        `${who} was let go. Morale fell ${Math.round(event.moraleLost)} points.` +
        ticketsReturned(event.releasedTickets)
      );
    case STAFF_CHANGE.quit:
      return `${who} quit: ${event.reason}.${ticketsReturned(event.releasedTickets)}`;
  }
}
