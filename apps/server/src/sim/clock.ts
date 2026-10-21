/**
 * The in-game clock, as the rooms' simulation ticks run it.
 *
 * This is the part of the clock that needs a server: it measures real time
 * and keeps the seconds the schema does not replicate. How fast it runs is
 * `@sim/shared`'s `clock.ts`, which is also where every tunable lives; nothing
 * here is one.
 *
 * One clock serves the whole building: the server makes it once and every
 * floor's room steps it on its own tick, so a floor opened later shows the
 * time the others do rather than its own opening time. A step that finds no
 * time has passed since another room's moves nothing.
 *
 * It runs inside the tick, so it is synchronous and cheap by construction: a
 * step is an addition, a comparison, and a write only when the minute changes.
 */

import { type OfficeState, SECONDS_PER_DAY, STARTING_MINUTE_OF_DAY, simSecondsFor } from "@sim/shared";

/** The clock's server-only half, shared by every room that steps it. */
export interface SimClock {
  /** Real time of the latest step, by whichever room took it. */
  lastStepAt: number;
  /** In-game seconds into the current day, which the schema replicates only to the minute. */
  seconds: number;
}

export function createSimClock(now: number, minuteOfDay = STARTING_MINUTE_OF_DAY): SimClock {
  return { lastStepAt: now, seconds: minuteOfDay * 60 };
}

/** The minute of the day the clock shows, as the schema replicates it. */
export function minuteOf(clock: SimClock): number {
  return Math.floor(clock.seconds / 60);
}

/**
 * Advances the clock by however much real time has passed since its last
 * step, wrapping at midnight, and shows it in a room's state.
 *
 * Rooms tick on their own timers, so one may step with a `now` a moment
 * behind another's; that is no time at all rather than time run backwards.
 */
export function stepClock(state: OfficeState, clock: SimClock, now: number): void {
  const elapsed = now - clock.lastStepAt;
  if (elapsed > 0) {
    clock.lastStepAt = now;
    clock.seconds = (clock.seconds + simSecondsFor(elapsed)) % SECONDS_PER_DAY;
  }
  state.minuteOfDay = minuteOf(clock);
}
