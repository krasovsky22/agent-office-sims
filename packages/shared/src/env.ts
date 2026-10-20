/**
 * The settings rules the server and the runner both read their environment by.
 *
 * Each used to keep its own copy, and the copies drifted: the server took
 * repository names the sync contract refuses. One copy means a rule changes in
 * one place, and a deploy either side would refuse fails at boot on both.
 */

/** An environment as either process reads it; `process.env` is one. */
export type Env = Readonly<Record<string, string | undefined>>;

/** The repository the board shows and the runner works on when none is configured: this one. */
export const DEFAULT_REPOSITORY = "krasovsky22/agent-office-sims";

/** `owner/name`, in the characters and lengths GitHub allows in each. */
export const REPOSITORY_PATTERN = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/**
 * Shortest shared secret the server's agent routes and the runner accept.
 *
 * Those routes are reachable by anyone who can reach the server, so the secret
 * is all that stands between a stranger and the people on the floor; a short
 * one is a configuration mistake worth refusing to boot over.
 */
export const MIN_SECRET_LENGTH = 16;

/** A variable's value, trimmed; `""` when unset. */
export function readEnv(env: Env, name: string): string {
  return env[name]?.trim() ?? "";
}

/**
 * A whole number from `min` to `max`, or `fallback` when unset.
 *
 * @param means what the number counts and its range, finishing the sentence
 * "must be a whole number …", e.g. `of seconds, at least 15`.
 */
export function readWholeNumber(
  env: Env,
  name: string,
  { fallback, min, max = Number.POSITIVE_INFINITY, means }: { fallback: number; min: number; max?: number; means: string },
): number {
  const raw = readEnv(env, name);
  if (raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number ${means}, got "${raw}"`);
  }
  return value;
}

/** One of `choices`, matched without regard to case, or `fallback` when unset. */
export function readChoice<T extends string>(env: Env, name: string, choices: readonly T[], fallback: T): T {
  const raw = readEnv(env, name).toLowerCase();
  if (raw === "") {
    return fallback;
  }
  const choice = choices.find((candidate) => candidate === raw);
  if (choice === undefined) {
    throw new Error(`${name} must be one of ${choices.join(", ")}, got "${env[name]}"`);
  }
  return choice;
}
