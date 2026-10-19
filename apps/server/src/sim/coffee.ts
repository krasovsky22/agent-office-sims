/**
 * The coffee each occupant carries away from the machine, drunk a sip at a time.
 *
 * A cup is poured when an occupant takes the coffee machine, and from the end
 * of that break it loses one sip every `COFFEE_SIP_INTERVAL_MS` until it is
 * empty. Only the count is replicated, as `coffeeSips`; when the next sip is
 * due is the server's business, kept here, so no client decides how fast
 * anyone drinks and nothing about the schedule has to cross the wire.
 *
 * Synchronous and checked against the clock in the room's tick, like a timed
 * hold, so the tick never waits on a timer.
 */

import { COFFEE_SIPS, COFFEE_SIP_INTERVAL_MS, type Occupant } from "@sim/shared";

export class CoffeeCups {
  /** Room clock time each cup's next sip is due, by occupant id. */
  private readonly nextSipAt = new Map<string, number>();

  /**
   * Fills an occupant's cup, replacing whatever was left in the one they had.
   *
   * @param drinkFrom room clock time the break ends; the first sip is one
   * interval after it, so nobody sips while still standing at the machine.
   */
  public pour(id: string, occupant: Occupant, drinkFrom: number): void {
    occupant.coffeeSips = COFFEE_SIPS;
    this.nextSipAt.set(id, drinkFrom + COFFEE_SIP_INTERVAL_MS);
  }

  /** Whether an occupant has a cup in hand. */
  public isHolding(id: string): boolean {
    return this.nextSipAt.has(id);
  }

  /**
   * Takes every sip that has come due, and forgets cups whose holder has left.
   *
   * A cup the tick fell behind on loses one sip per tick rather than several
   * at once, so every client sees each sip as its own drop in the count.
   */
  public step(now: number, occupants: { get(id: string): Occupant | undefined }): void {
    for (const [id, dueAt] of this.nextSipAt) {
      const occupant = occupants.get(id);
      if (occupant === undefined) {
        this.nextSipAt.delete(id);
        continue;
      }
      if (now < dueAt) {
        continue;
      }
      occupant.coffeeSips = Math.max(occupant.coffeeSips - 1, 0);
      if (occupant.coffeeSips === 0) {
        this.nextSipAt.delete(id);
      } else {
        this.nextSipAt.set(id, Math.max(dueAt + COFFEE_SIP_INTERVAL_MS, now));
      }
    }
  }
}
