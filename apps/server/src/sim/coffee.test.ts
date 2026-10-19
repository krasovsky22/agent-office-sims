/**
 * The cup's clock: ten sips, one interval apart, one per tick at most, and
 * gone after the last, so every client can read the whole cup off one count.
 */

import { COFFEE_SIPS, COFFEE_SIP_INTERVAL_MS, HumanPlayer, type Occupant } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { CoffeeCups } from "./coffee.js";

function occupantsWith(id: string): Map<string, Occupant> {
  const player = new HumanPlayer();
  player.id = id;
  return new Map([[id, player]]);
}

describe("CoffeeCups", () => {
  it("takes one sip per interval and empties the cup after the last", () => {
    const cups = new CoffeeCups();
    const occupants = occupantsWith("alice");
    const alice = occupants.get("alice") as Occupant;
    cups.pour("alice", alice, 0);

    const seen: number[] = [];
    for (let sip = 1; sip <= COFFEE_SIPS; sip += 1) {
      cups.step(sip * COFFEE_SIP_INTERVAL_MS - 1, occupants);
      expect(alice.coffeeSips).toBe(COFFEE_SIPS - sip + 1);
      cups.step(sip * COFFEE_SIP_INTERVAL_MS, occupants);
      seen.push(alice.coffeeSips);
    }

    expect(seen).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    expect(cups.isHolding("alice")).toBe(false);
    cups.step(100 * COFFEE_SIP_INTERVAL_MS, occupants);
    expect(alice.coffeeSips).toBe(0);
  });

  it("takes a late tick's overdue sips one tick at a time", () => {
    const cups = new CoffeeCups();
    const occupants = occupantsWith("alice");
    const alice = occupants.get("alice") as Occupant;
    cups.pour("alice", alice, 0);

    cups.step(5 * COFFEE_SIP_INTERVAL_MS, occupants);
    expect(alice.coffeeSips).toBe(COFFEE_SIPS - 1);
    cups.step(5 * COFFEE_SIP_INTERVAL_MS, occupants);
    expect(alice.coffeeSips).toBe(COFFEE_SIPS - 2);
  });

  it("refills a cup poured again before it was finished", () => {
    const cups = new CoffeeCups();
    const occupants = occupantsWith("alice");
    const alice = occupants.get("alice") as Occupant;
    cups.pour("alice", alice, 0);
    cups.step(COFFEE_SIP_INTERVAL_MS, occupants);

    cups.pour("alice", alice, COFFEE_SIP_INTERVAL_MS);
    expect(alice.coffeeSips).toBe(COFFEE_SIPS);
    cups.step(COFFEE_SIP_INTERVAL_MS * 2 - 1, occupants);
    expect(alice.coffeeSips).toBe(COFFEE_SIPS);
  });

  it("forgets the cup of an occupant who has left", () => {
    const cups = new CoffeeCups();
    const occupants = occupantsWith("alice");
    cups.pour("alice", occupants.get("alice") as Occupant, 0);
    occupants.delete("alice");

    cups.step(0, occupants);
    expect(cups.isHolding("alice")).toBe(false);
  });
});
