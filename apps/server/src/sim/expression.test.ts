/**
 * The rate limit is an acceptance criterion rather than an implementation
 * detail — spamming has to be stopped here, on the server, and not merely by a
 * client that chose to behave — so it gets tests.
 *
 * Time is passed in rather than read from a clock, which is why none of this
 * needs fake timers.
 */

import {
  CHAT_BURST_ALLOWANCE,
  CHAT_REFILL_PER_SECOND,
  EMOTE_BURST_ALLOWANCE,
} from "@sim/shared";
import { describe, expect, it } from "vitest";

import { createExpressionBudget, createTokenBucket, tryConsume } from "./expression.js";

/** Drains a bucket and returns how many of `attempts` were allowed. */
function allowedOf(bucket: ReturnType<typeof createTokenBucket>, attempts: number, now: number) {
  let allowed = 0;
  for (let i = 0; i < attempts; i += 1) {
    if (tryConsume(bucket, now)) {
      allowed += 1;
    }
  }
  return allowed;
}

describe("tryConsume", () => {
  it("allows a burst up to the capacity and then stops", () => {
    const bucket = createTokenBucket(3, 1, 0);
    expect(allowedOf(bucket, 10, 0)).toBe(3);
  });

  it("refuses everything sent in the same instant once drained", () => {
    const bucket = createTokenBucket(2, 1, 0);
    allowedOf(bucket, 2, 0);
    expect(tryConsume(bucket, 0)).toBe(false);
  });

  it("refills at the configured rate", () => {
    const bucket = createTokenBucket(4, 2, 0);
    allowedOf(bucket, 4, 0);
    // Half a second at two per second is one token.
    expect(tryConsume(bucket, 500)).toBe(true);
    expect(tryConsume(bucket, 500)).toBe(false);
  });

  it("accumulates a fractional refill rather than rounding it away", () => {
    const bucket = createTokenBucket(1, 0.5, 0);
    expect(tryConsume(bucket, 0)).toBe(true);
    // Three 700ms gaps at half a token per second: 0.35, 0.70, 1.05.
    expect(tryConsume(bucket, 700)).toBe(false);
    expect(tryConsume(bucket, 1400)).toBe(false);
    expect(tryConsume(bucket, 2100)).toBe(true);
  });

  it("never banks more than the capacity, however long the silence", () => {
    const bucket = createTokenBucket(2, 1, 0);
    expect(allowedOf(bucket, 10, 600_000)).toBe(2);
  });

  it("treats a clock that went backwards as no elapsed time", () => {
    const bucket = createTokenBucket(1, 10, 1000);
    expect(tryConsume(bucket, 1000)).toBe(true);
    expect(tryConsume(bucket, 0)).toBe(false);
  });

  it("holds the long-run rate at the refill rate under sustained spam", () => {
    // Just under ten seconds of a client sending as fast as it can, in 10ms
    // steps: a thousand attempts, which is what spamming actually looks like.
    const bucket = createTokenBucket(4, 1, 0);
    let attempts = 0;
    let allowed = 0;
    for (let now = 0; now < 10_000; now += 10) {
      attempts += 1;
      if (tryConsume(bucket, now)) {
        allowed += 1;
      }
    }
    // The opening burst of 4 plus one per second for the 9.99 seconds the
    // window covers, and not one more however hard the client tried.
    expect(attempts).toBe(1000);
    expect(allowed).toBe(13);
  });
});

describe("createExpressionBudget", () => {
  it("gives emotes and chat separate budgets", () => {
    const budget = createExpressionBudget(0);
    allowedOf(budget.chat, CHAT_BURST_ALLOWANCE, 0);

    expect(tryConsume(budget.chat, 0)).toBe(false);
    expect(tryConsume(budget.emote, 0)).toBe(true);
  });

  it("starts both buckets full, from the shared allowances", () => {
    const budget = createExpressionBudget(0);
    expect(allowedOf(budget.emote, 50, 0)).toBe(EMOTE_BURST_ALLOWANCE);
    expect(allowedOf(budget.chat, 50, 0)).toBe(CHAT_BURST_ALLOWANCE);
  });

  it("refills chat at the shared rate", () => {
    const oneTokenMs = 1000 / CHAT_REFILL_PER_SECOND;

    // Two buckets rather than two calls on one: a denied call still advances
    // the bucket's clock, so asking the same bucket twice would be testing the
    // second gap rather than the first.
    const drained = () => {
      const budget = createExpressionBudget(0);
      allowedOf(budget.chat, CHAT_BURST_ALLOWANCE, 0);
      return budget.chat;
    };

    expect(tryConsume(drained(), oneTokenMs - 10)).toBe(false);
    expect(tryConsume(drained(), oneTokenMs + 10)).toBe(true);
  });
});
