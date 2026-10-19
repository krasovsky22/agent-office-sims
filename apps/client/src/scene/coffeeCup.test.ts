/**
 * The cup's reading of the replicated sip count: a drop is a sip, the first
 * count is not, and the cup stays in hand until the last sip is drunk.
 */

import { COFFEE_SIPS } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { CoffeeCup, SIP_DURATION_MS, SipTracker, sipLift } from "./coffeeCup.js";

describe("sipLift", () => {
  it("raises the cup to the mouth and brings it back down", () => {
    expect(sipLift(0)).toBe(0);
    expect(sipLift(SIP_DURATION_MS * 0.15)).toBeGreaterThan(0);
    expect(sipLift(SIP_DURATION_MS * 0.15)).toBeLessThan(1);
    expect(sipLift(SIP_DURATION_MS / 2)).toBe(1);
    expect(sipLift(SIP_DURATION_MS * 0.85)).toBeLessThan(1);
    expect(sipLift(SIP_DURATION_MS)).toBe(0);
    expect(sipLift(-1)).toBe(0);
  });
});

describe("SipTracker", () => {
  it("does not take the first count it sees for a sip", () => {
    const tracker = new SipTracker();
    tracker.observe(7, 0);
    expect(tracker.sipElapsed(0)).toBeUndefined();
    expect(tracker.holding(0, false)).toBe(true);
  });

  it("plays a sip for each drop in the count", () => {
    const tracker = new SipTracker();
    tracker.observe(COFFEE_SIPS, 0);
    tracker.observe(COFFEE_SIPS, 100);
    expect(tracker.sipElapsed(100)).toBeUndefined();

    tracker.observe(COFFEE_SIPS - 1, 1000);
    expect(tracker.sipElapsed(1000)).toBe(0);
    expect(tracker.sipElapsed(1000 + SIP_DURATION_MS - 1)).toBe(SIP_DURATION_MS - 1);
    expect(tracker.sipElapsed(1000 + SIP_DURATION_MS)).toBeUndefined();
  });

  it("does not play a sip for a refill", () => {
    const tracker = new SipTracker();
    tracker.observe(3, 0);
    tracker.observe(COFFEE_SIPS, 10);
    expect(tracker.sipElapsed(10)).toBeUndefined();
  });

  it("keeps the cup in hand through the last sip, then takes it away", () => {
    const tracker = new SipTracker();
    tracker.observe(1, 0);
    tracker.observe(0, 1000);
    expect(tracker.holding(1000 + SIP_DURATION_MS - 1, false)).toBe(true);
    expect(tracker.holding(1000 + SIP_DURATION_MS, false)).toBe(false);
  });

  it("puts a cup in hand at the machine before any coffee is counted", () => {
    const tracker = new SipTracker();
    tracker.observe(0, 0);
    expect(tracker.holding(0, true)).toBe(true);
    expect(tracker.holding(0, false)).toBe(false);
  });
});

describe("CoffeeCup", () => {
  it("is hidden with no coffee, steams while held, and lifts mid-sip", () => {
    const cup = new CoffeeCup();
    cup.update(0, false, 0, undefined, 0);
    expect(cup.group.visible).toBe(false);

    cup.update(COFFEE_SIPS, false, 100, undefined, 0);
    expect(cup.group.visible).toBe(true);
    const [held, steam] = cup.group.children;
    const restY = held?.position.y ?? Number.NaN;
    expect(steam?.visible).toBe(true);

    cup.update(COFFEE_SIPS - 1, false, 200, undefined, 0);
    cup.update(COFFEE_SIPS - 1, false, 200 + SIP_DURATION_MS / 2, undefined, 0);
    expect(held?.position.y).toBeGreaterThan(restY);
    expect(steam?.visible).toBe(false);
  });
});
