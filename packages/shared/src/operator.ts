/**
 * The operator: the player who proved they know the server's passphrase.
 *
 * Nothing authenticates a player — the CEO is whoever joined first — and that
 * is fine for the simulated staff. It is not fine once a CEO's word becomes
 * code run and pushed on a real machine, so commands that reach a real coding
 * agent also take the operator passphrase (`mayCommandRealAgents` in
 * `work.ts`). This module is what both sides need about proving it: the limits
 * on a passphrase and on guessing one, and why an attempt was turned down.
 * The passphrase itself lives only in the server's environment.
 */

/**
 * Shortest passphrase the server will boot with. It is all that stands
 * between a stranger with the page open and the runner's host, so a short one
 * is a configuration mistake rather than a preference.
 */
export const MIN_OPERATOR_PASSPHRASE_LENGTH = 16;

/** Longest attempt the server will read; past this it is not a passphrase anyone typed. */
export const MAX_OPERATOR_PASSPHRASE_LENGTH = 256;

/** Attempts a client may make at once before it has to wait. */
export const OPERATOR_ATTEMPT_ALLOWANCE = 5;

/** The window those attempts are spread over, in seconds: five every five minutes. */
export const OPERATOR_ATTEMPT_WINDOW_SECONDS = 300;

/**
 * Wrong answers the whole server may hear before verifying is closed to
 * everyone. A client's own allowance goes when it leaves, and a room's when it
 * empties; this one lasts as long as the server, so leaving and rejoining
 * does not start a guesser over.
 */
export const OPERATOR_FAILURE_ALLOWANCE = 20;

/** The window the server's wrong answers are spread over, in seconds. */
export const OPERATOR_FAILURE_WINDOW_SECONDS = 300;

/** Why an attempt to verify as operator was turned down. Refusal changes nothing. */
export const OPERATOR_REJECTION = {
  /** Not the passphrase. */
  wrong: "wrong",
  /** Too many attempts; the next one is refused unread until the allowance refills. */
  throttled: "throttled",
  /** The server has heard too many wrong answers; every attempt is refused unread until they refill. */
  locked: "locked",
  /** This server has no operator passphrase, so there is nothing to verify. */
  unavailable: "unavailable",
} as const;

export type OperatorRejection = (typeof OPERATOR_REJECTION)[keyof typeof OPERATOR_REJECTION];
