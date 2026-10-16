/**
 * The in-game clock, as the room's simulation tick runs it.
 *
 * This is the part of the clock that needs a room: it measures real time
 * against the room clock and keeps the seconds the schema does not replicate.
 * How fast it runs is `@sim/shared`'s `clock.ts`, which is also where every
 * tunable lives; nothing here is one.
 *
 * It runs inside the tick, so it is synchronous and cheap by construction: a
 * step is an addition, a comparison, and a write only when the minute changes.
 */

import { type OfficeState, SECONDS_PER_DAY, simSecondsFor } from "@sim/shared";

/** The room's server-only half of the clock. */
export interface SimClock {
  /** Room clock time of the previous step. */
  lastStepAt: number;
  /** In-game seconds into the current day, which the schema replicates only to the minute. */
  seconds: number;
}

export function createSimClock(state: OfficeState, now: number): SimClock {
  return { lastStepAt: now, seconds: state.minuteOfDay * 60 };
}

/** Advances the clock by however much room time has passed, wrapping at midnight. */
export function stepClock(state: OfficeState, clock: SimClock, now: number): void {
  const elapsed = now - clock.lastStepAt;
  clock.lastStepAt = now;
  clock.seconds = (clock.seconds + simSecondsFor(elapsed)) % SECONDS_PER_DAY;

  const minute = Math.floor(clock.seconds / 60);
  if (state.minuteOfDay !== minute) {
    state.minuteOfDay = minute;
  }
}
