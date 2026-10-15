/**
 * The in-game time of day, smooth enough to light a scene by.
 *
 * The server replicates the clock in whole minutes, a few times a second. That
 * is fine for a HUD showing quarter hours, but a sun driven straight off it
 * would move in small visible jumps. Between patches this runs the clock on
 * locally at the server's rate, and never more than a minute past the last one
 * it heard: the next patch is due before then, so a stalled clock stops the
 * light within a minute rather than running it on regardless.
 */

import { MINUTES_PER_DAY, SIM_MINUTES_PER_REAL_SECOND } from "@sim/shared";

/** Furthest the local clock runs past the last replicated minute. */
const MAX_LEAD_MINUTES = 1;

export class DayClock {
  private minute: number | undefined;
  private heardAtMs = 0;

  /** Takes the replicated clock. */
  public observe(minuteOfDay: number, nowMs: number): void {
    if (minuteOfDay !== this.minute) {
      this.minute = minuteOfDay;
      this.heardAtMs = nowMs;
    }
  }

  /**
   * Minutes since midnight at `nowMs`, fractional and in `[0, MINUTES_PER_DAY)`.
   *
   * @returns undefined until the first patch has carried the clock.
   */
  public minuteAt(nowMs: number): number | undefined {
    if (this.minute === undefined) {
      return undefined;
    }
    const lead = Math.min(Math.max(nowMs - this.heardAtMs, 0) * SIM_MINUTES_PER_REAL_SECOND / 1000, MAX_LEAD_MINUTES);
    return (this.minute + lead) % MINUTES_PER_DAY;
  }
}
