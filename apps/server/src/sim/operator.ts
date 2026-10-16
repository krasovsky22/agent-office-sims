/**
 * Checking an attempt at the operator passphrase.
 *
 * The passphrase is closed over here and nowhere else: the room is handed a
 * gate that can answer "is this it?" and cannot say what it is, so it never
 * sits in room options, replicated state or anything a log line could reach.
 *
 * The comparison takes the same time however much of an attempt is right.
 * Both sides are hashed first, so the two buffers compared are always the same
 * length and the length of the passphrase does not leak through an early
 * return either. Guessing is held back by the per-client allowance below, and
 * by the gate's own allowance of wrong answers: the server makes one gate, so
 * every room, and every room after it, spends from that one allowance.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import {
  OPERATOR_ATTEMPT_ALLOWANCE,
  OPERATOR_ATTEMPT_WINDOW_SECONDS,
  OPERATOR_FAILURE_ALLOWANCE,
  OPERATOR_FAILURE_WINDOW_SECONDS,
} from "@sim/shared";

import { type TokenBucket, createTokenBucket, hasToken, tryConsume } from "./expression.js";

export interface OperatorGate {
  /** Whether the allowance of wrong answers is spent, so no attempt should be read. */
  readonly locked: () => boolean;
  /** Whether `attempt` is the passphrase; a wrong one spends from the allowance. */
  readonly verify: (attempt: string) => boolean;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function createOperatorGate(passphrase: string): OperatorGate {
  const expected = digest(passphrase);
  const failures = createTokenBucket(
    OPERATOR_FAILURE_ALLOWANCE,
    OPERATOR_FAILURE_ALLOWANCE / OPERATOR_FAILURE_WINDOW_SECONDS,
    Date.now(),
  );
  return {
    locked: () => !hasToken(failures, Date.now()),
    verify: (attempt) => {
      if (timingSafeEqual(digest(attempt), expected)) {
        return true;
      }
      tryConsume(failures, Date.now());
      return false;
    },
  };
}

/** Narrows a room option, which Colyseus may have merged with a client's join options. */
export function isOperatorGate(value: unknown): value is OperatorGate {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as OperatorGate).verify === "function" &&
    typeof (value as OperatorGate).locked === "function"
  );
}

/**
 * One client's allowance of attempts: {@link OPERATOR_ATTEMPT_ALLOWANCE} at
 * once, refilling over {@link OPERATOR_ATTEMPT_WINDOW_SECONDS}, so a typo or
 * two costs nothing and a script guessing gets five tries every five minutes.
 */
export function createOperatorAttempts(now: number): TokenBucket {
  return createTokenBucket(
    OPERATOR_ATTEMPT_ALLOWANCE,
    OPERATOR_ATTEMPT_ALLOWANCE / OPERATOR_ATTEMPT_WINDOW_SECONDS,
    now,
  );
}

