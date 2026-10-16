/**
 * How a manager planner fails, and how the advisor tells the CEO it did.
 *
 * A planner makes one attempt and may throw; `./advisor.ts` turns whatever it
 * threw into one of {@link ADVICE_FAILURE}'s reasons, and needs to know only
 * whether trying again could help. {@link PlannerError} is how a planner says
 * that, and {@link classifyError} is how an Anthropic SDK error is read into
 * one, so the model planner never has to decide retryability itself.
 */

import Anthropic from "@anthropic-ai/sdk";

export const ADVICE_FAILURE = {
  /** A call budget refused the call; nothing was spent on it. */
  budgetExhausted: "budget-exhausted",
  /** The planner did not answer in time, on every attempt made. */
  timeout: "timeout",
  /** The planner answered with an error, a refusal, or something unusable. */
  providerError: "provider-error",
  /** The caller's signal aborted; whatever was in flight was abandoned. */
  cancelled: "cancelled",
} as const;

export type AdviceFailureReason = (typeof ADVICE_FAILURE)[keyof typeof ADVICE_FAILURE];

/**
 * A failed attempt, as a planner reports it.
 *
 * Anything else a planner throws is treated as a non-retryable provider error.
 */
export class PlannerError extends Error {
  public readonly retryable: boolean;
  /** How long the provider asked to be left alone, if it said. */
  public readonly retryAfterMs: number | undefined;
  /** Tokens the failed attempt still spent, e.g. on a refusal. */
  public readonly tokensUsed: number;

  public constructor(
    message: string,
    options: { retryable: boolean; retryAfterMs?: number | undefined; tokensUsed?: number },
  ) {
    super(message);
    this.name = "PlannerError";
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
    this.tokensUsed = options.tokensUsed ?? 0;
  }
}

/** `retry-after-ms`, or `retry-after` in seconds or as an HTTP date. */
function retryAfterMs(headers: Headers | undefined): number | undefined {
  const ms = Number(headers?.get("retry-after-ms") ?? Number.NaN);
  if (Number.isFinite(ms) && ms >= 0) {
    return ms;
  }
  const raw = headers?.get("retry-after");
  if (raw === null || raw === undefined) {
    return undefined;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** The SDK's error, as a failure that says whether a retry could help. */
export function classifyError(error: unknown): PlannerError {
  if (error instanceof PlannerError) {
    return error;
  }
  // Checked before the status codes: a connection error is also an APIError, with no status.
  if (error instanceof Anthropic.APIConnectionError) {
    return new PlannerError("could not reach the model provider", { retryable: true });
  }
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new PlannerError(`the model provider rejected the API key (${error.status})`, { retryable: false });
  }
  if (error instanceof Anthropic.APIError && error.status !== undefined) {
    const status = error.status;
    // 408 timeout, 409 conflict, 429 rate limit, 5xx including 529 overloaded.
    const retryable = status === 408 || status === 409 || status === 429 || status >= 500;
    const kind = status === 429 ? "rate limited" : status >= 500 ? "unavailable" : "refused the request";
    return new PlannerError(`the model provider ${kind} (${status})`, {
      retryable,
      retryAfterMs: retryable ? retryAfterMs(error.headers) : undefined,
    });
  }
  const message = error instanceof Error && error.message !== "" ? error.message : "the model call failed";
  return new PlannerError(message, { retryable: false });
}
