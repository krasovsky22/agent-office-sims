/**
 * The in-game clock: where it starts and how fast it runs.
 *
 * The office's day/night lighting reads it, so it is replicated and the server
 * alone moves it; the client only runs it on smoothly between patches. Every
 * tunable lives here, so changing the length of a day is an edit to this file
 * and to nothing else.
 */

/**
 * In-game minutes that pass per real second: the whole speed of the clock.
 *
 * At 12 a day lasts two real minutes, so a few minutes of play sees the light
 * go round.
 */
export const SIM_MINUTES_PER_REAL_SECOND = 12;

export const MINUTES_PER_DAY = 24 * 60;

/** Where a room's clock starts: the office opening, not midnight. */
export const STARTING_MINUTE_OF_DAY = 9 * 60;

/**
 * Longest stretch of real time the clock will credit to one step.
 *
 * The tick runs every 50ms, so this only matters if the process stalls — a
 * debugger pause, a laptop lid — and keeps the first step back from jumping
 * the light by however long the stall was.
 */
export const MAX_CLOCK_STEP_MS = 1000;

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
