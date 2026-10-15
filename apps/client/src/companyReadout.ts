/**
 * What the HUD says about the company, worked out from the replicated numbers.
 *
 * The server patches the clock several times a second, and the HUD should not
 * re-render for each of them. Turning the numbers into the strings on screen
 * first, and comparing those, means React hears about a change only when a
 * player could see one: a new quarter hour, a payday, a morale shift.
 */

import { CLOCK_DISPLAY_STEP_MINUTES, COMPANY_STATUS } from "@sim/shared";

import type { CompanyView } from "./net/room.js";

export interface CompanyReadout {
  readonly day: string;
  readonly clock: string;
  readonly cash: string;
  readonly morale: string;
  readonly productivity: string;
  /** Whether the company has run out of cash and the clock has stopped. */
  readonly bankrupt: boolean;
}

const CASH_FORMAT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/** `HH:MM` on a 24-hour clock, rounded down to the display step. */
export function formatClock(minuteOfDay: number): string {
  const shown = minuteOfDay - (minuteOfDay % CLOCK_DISPLAY_STEP_MINUTES);
  const hours = Math.floor(shown / 60);
  const minutes = shown % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function formatCash(cash: number): string {
  return CASH_FORMAT.format(cash);
}

export function readCompany(company: CompanyView): CompanyReadout {
  return {
    day: `Day ${company.day}`,
    clock: formatClock(company.minuteOfDay),
    cash: formatCash(company.cash),
    morale: `${Math.round(company.morale)}%`,
    productivity: `${Math.round(company.productivity)}`,
    bankrupt: company.status === COMPANY_STATUS.bankrupt,
  };
}

/** Whether two readouts would put the same thing on screen. */
export function sameReadout(a: CompanyReadout | undefined, b: CompanyReadout): boolean {
  return (
    a !== undefined &&
    a.day === b.day &&
    a.clock === b.clock &&
    a.cash === b.cash &&
    a.morale === b.morale &&
    a.productivity === b.productivity &&
    a.bankrupt === b.bankrupt
  );
}
