/**
 * Rate limiting for the things an occupant does on purpose: emotes and chat.
 *
 * Movement is limited by physics — the speed clamp in `movement.ts` bounds how
 * much of it the server will accept. Expression has no physics to lean on, so a
 * client that wants to fire a hundred emotes a second is stopped by a budget
 * instead.
 *
 * The budget is a token bucket per command per occupant. A bucket is the right
 * shape here because the two things a limiter has to get right pull in opposite
 * directions: a person waving twice in quick succession is normal, and a client
 * waving fifty times in a row is not. A fixed minimum interval would reject the
 * first; a fixed window would wave through a burst at the boundary. A bucket
 * allows a short burst and then holds the long-run rate at the refill rate.
 *
 * This runs on the message handler, not the simulation tick, and is synchronous
 * and allocation-free per call for the same reason the tick is: there is no
 * point at which expression can make the room wait on anything.
 *
 * It lives on the server because that is where it has to be enforced. The
 * client is welcome to limit itself as well; whether it does changes nothing
 * here, because the client is also welcome to be a script with a socket.
 */

import {
  CHAT_BURST_ALLOWANCE,
  CHAT_REFILL_PER_SECOND,
  EMOTE_BURST_ALLOWANCE,
  EMOTE_REFILL_PER_SECOND,
} from "@sim/shared";

/**
 * A token bucket.
 *
 * `tokens` is fractional: a refill rate below one per second only produces a
 * whole token after more than a second, and rounding that down to zero each
 * time would never let the bucket refill at all.
 */
export interface TokenBucket {
  readonly capacity: number;
  readonly refillPerSecond: number;
  tokens: number;
  /** Clock time the token count was last brought up to date. */
  lastRefillAt: number;
}

/** A full bucket. An occupant's first action is never the one that is dropped. */
export function createTokenBucket(
  capacity: number,
  refillPerSecond: number,
  now: number,
): TokenBucket {
  return { capacity, refillPerSecond, tokens: capacity, lastRefillAt: now };
}

/**
 * Spends one token if there is one.
 *
 * @param now the room clock, in milliseconds.
 * @returns whether the action is allowed. A `false` is the caller's cue to drop
 * the message; nothing is queued, because a wave that arrives three seconds
 * late is not the wave anyone meant.
 */
export function tryConsume(bucket: TokenBucket, now: number): boolean {
  const elapsedMs = Math.max(now - bucket.lastRefillAt, 0);
  bucket.tokens = Math.min(
    bucket.capacity,
    bucket.tokens + (elapsedMs * bucket.refillPerSecond) / 1000,
  );
  bucket.lastRefillAt = now;

  if (bucket.tokens < 1) {
    return false;
  }
  bucket.tokens -= 1;
  return true;
}

/** One occupant's expression budgets. */
export interface ExpressionBudget {
  readonly emote: TokenBucket;
  readonly chat: TokenBucket;
}

export function createExpressionBudget(now: number): ExpressionBudget {
  return {
    emote: createTokenBucket(EMOTE_BURST_ALLOWANCE, EMOTE_REFILL_PER_SECOND, now),
    chat: createTokenBucket(CHAT_BURST_ALLOWANCE, CHAT_REFILL_PER_SECOND, now),
  };
}
