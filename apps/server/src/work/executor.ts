/**
 * The ticket work executor: given a ticket and the agent holding it, produce
 * the deliverable.
 *
 * What an agent produces is a text artifact — a specification, an analysis, an
 * email, a plan — because it reads directly in the board panel and needs no
 * sandbox. Producing code changes is a different and much larger feature.
 *
 * The interface is one function, {@link WorkExecutor.work}, and its promise is
 * the module's contract: **it always resolves, never rejects.** A timeout, a
 * spent budget, a refusal or an unreachable provider all come back as a
 * {@link WorkFailure} the caller can show on the ticket, because whatever calls
 * this sits on the path that feeds the simulation, and an exception escaping
 * there would take the room down with it.
 *
 * Where the text comes from is a {@link WorkProvider}: canned text on a timer
 * (`./mockProvider.ts`) or a language model (`./modelProvider.ts`). A provider
 * makes one attempt and may throw; everything that makes an attempt safe —
 * the call budget, the per-attempt timeout, bounded retry with backoff — lives
 * here, once, so every provider gets it and none can skip it.
 *
 * `work` is async and takes seconds. It must be called from an agent's own
 * loop and its result handed to the room, never awaited inside the tick. That
 * loop can be torn down mid-call, when its room closes, so `work` takes a
 * signal: aborting it ends the call at once, with every timer it started
 * cleared, rather than leaving a provider running for a room that is gone.
 */

import { type Ticket } from "@sim/shared";

import { type BudgetDecision, type CallBudget } from "./budget.js";

/** The part of a board ticket the work depends on. */
export type WorkTicket = Pick<Ticket, "id" | "title" | "body">;

/** Who is doing the work. */
export interface WorkContext {
  readonly agentName: string;
  /** The agent's role, e.g. "Product Manager"; it shapes what kind of deliverable comes back. */
  readonly jobTitle: string;
}

/** One provider attempt's output, before the executor accepts it. */
export interface WorkOutput {
  /** The deliverable itself, ready to store on the ticket. */
  readonly artifact: string;
  /** One line saying what the artifact is, for a card or a log. */
  readonly summary: string;
  /** Model tokens this attempt spent; `0` when nothing was spent. */
  readonly tokensUsed: number;
}

export interface WorkSuccess extends WorkOutput {
  readonly ok: true;
  /** Calls made, retries included. */
  readonly attempts: number;
}

export const WORK_FAILURE = {
  /** A call budget refused the call; nothing was spent on it. */
  budgetExhausted: "budget-exhausted",
  /** The provider did not answer in time, on every attempt made. */
  timeout: "timeout",
  /** The provider answered with an error, a refusal, or something unusable. */
  providerError: "provider-error",
  /** The caller's signal aborted; whatever was in flight was abandoned. */
  cancelled: "cancelled",
} as const;

export type WorkFailureReason = (typeof WORK_FAILURE)[keyof typeof WORK_FAILURE];

export interface WorkFailure {
  readonly ok: false;
  readonly reason: WorkFailureReason;
  /** Readable, and safe to show: it never carries a credential. */
  readonly message: string;
  /** Tokens spent on the attempts that failed. */
  readonly tokensUsed: number;
  /** Calls made before giving up; `0` when the budget refused the first. */
  readonly attempts: number;
  /** For a spent budget, the epoch milliseconds it refills, if a clock refills it. */
  readonly retryAt: number | undefined;
}

export type WorkResult = WorkSuccess | WorkFailure;

export interface WorkExecutor {
  /**
   * Resolves with the deliverable or a structured failure. Never rejects.
   * An aborted `signal` resolves it promptly as {@link WORK_FAILURE.cancelled}.
   */
  work(ticket: WorkTicket, context: WorkContext, signal?: AbortSignal): Promise<WorkResult>;
}

/**
 * Whether a value is a {@link WorkExecutor}, for a room that is handed one
 * through options a client's join options are merged into.
 */
export function isWorkExecutor(value: unknown): value is WorkExecutor {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<WorkExecutor>).work === "function"
  );
}

/**
 * One attempt at a ticket. It should stop when `signal` aborts; the executor
 * stops waiting at the timeout either way.
 */
export type WorkProvider = (
  ticket: WorkTicket,
  context: WorkContext,
  signal: AbortSignal,
) => Promise<WorkOutput>;

/**
 * A failed attempt, as a provider reports it.
 *
 * Anything else a provider throws is treated as a non-retryable provider error.
 */
export class WorkProviderError extends Error {
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
    this.name = "WorkProviderError";
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
    this.tokensUsed = options.tokensUsed ?? 0;
  }
}

export interface WorkExecutorOptions {
  readonly provider: WorkProvider;
  /** Absent means unlimited, which only a provider that spends nothing should be given. */
  readonly budget?: CallBudget | undefined;
  /** How long one attempt may take before it counts as timed out. */
  readonly timeoutMs?: number;
  /** Attempts per ticket, the first included. */
  readonly maxAttempts?: number;
  /** Wait before the first retry; it doubles on each one after. */
  readonly backoffMs?: number;
  /** Ceiling on any one wait, a provider's own `retry-after` included. */
  readonly maxBackoffMs?: number;
  /**
   * Injected so a test need not wait out real backoff. Should resolve early
   * when `signal` aborts; the executor stops waiting for it either way.
   */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Injected so a test can pin the jitter. In `[0, 1)`. */
  readonly random?: () => number;
}

/**
 * Two minutes. A model writing a page-long document takes tens of seconds;
 * one still going at two minutes is more likely stuck than nearly done.
 */
const DEFAULT_TIMEOUT_MS = 120_000;

/** One call and two retries: enough to ride out a blip, too few to run up a bill. */
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 2_000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Resolves when `signal` aborts, and lets go of it when `release` is called first. */
function whenAborted(signal: AbortSignal): { readonly aborted: Promise<void>; release(): void } {
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    onAbort = () => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    aborted,
    release: () => {
      if (onAbort !== undefined) {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

/** A signal that never aborts, for a caller that passed none. */
const NEVER = new AbortController().signal;

/** What one attempt came to; never a thrown error. */
type AttemptOutcome = { readonly kind: "ok"; readonly output: WorkOutput } | FailedAttempt;

interface FailedAttempt {
  readonly kind: "failed";
  readonly reason:
    | typeof WORK_FAILURE.timeout
    | typeof WORK_FAILURE.providerError
    | typeof WORK_FAILURE.cancelled;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly tokensUsed: number;
}

const TIMED_OUT = Symbol("timed out");
const CANCELLED = Symbol("cancelled");

/** What an absent budget always says. */
const UNLIMITED: BudgetDecision = { ok: true };

export function createWorkExecutor(options: WorkExecutorOptions): WorkExecutor {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  async function attempt(
    ticket: WorkTicket,
    context: WorkContext,
    cancel: AbortSignal,
  ): Promise<AttemptOutcome> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(TIMED_OUT);
      }, timeoutMs);
    });
    // The caller giving up wins the race too, so a provider that ignores its
    // signal still cannot keep this attempt — or its timer — alive.
    const caller = whenAborted(cancel);
    const cancelled = caller.aborted.then((): typeof CANCELLED => {
      controller.abort();
      return CANCELLED;
    });
    // Started inside a promise chain so a provider that throws synchronously
    // still lands in the catch below, and given a handler at once so one that
    // rejects after losing the race is not an unhandled rejection.
    const pending = Promise.resolve().then(() => options.provider(ticket, context, controller.signal));
    pending.catch(() => undefined);

    try {
      const output = await Promise.race([pending, deadline, cancelled]);
      if (output === CANCELLED) {
        return cancelledAttempt();
      }
      if (output === TIMED_OUT) {
        return timedOut();
      }
      const artifact = typeof output.artifact === "string" ? output.artifact.trim() : "";
      if (artifact === "") {
        return failed("the provider returned an empty artifact", false, undefined, output.tokensUsed);
      }
      const summary = typeof output.summary === "string" ? output.summary.trim() : "";
      return { kind: "ok", output: { artifact, summary, tokensUsed: output.tokensUsed } };
    } catch (error) {
      if (cancel.aborted) {
        return cancelledAttempt();
      }
      if (controller.signal.aborted) {
        return timedOut();
      }
      if (error instanceof WorkProviderError) {
        return failed(error.message, error.retryable, error.retryAfterMs, error.tokensUsed);
      }
      const message = error instanceof Error && error.message !== "" ? error.message : "the provider failed";
      return failed(message, false, undefined, 0);
    } finally {
      clearTimeout(timer);
      caller.release();
    }
  }

  function cancelledAttempt(): FailedAttempt {
    return {
      kind: "failed",
      reason: WORK_FAILURE.cancelled,
      message: "the work was cancelled",
      retryable: false,
      retryAfterMs: undefined,
      tokensUsed: 0,
    };
  }

  function timedOut(): AttemptOutcome {
    return {
      kind: "failed",
      reason: WORK_FAILURE.timeout,
      message: `no answer within ${Math.round(timeoutMs / 1000)}s`,
      retryable: true,
      retryAfterMs: undefined,
      tokensUsed: 0,
    };
  }

  function failed(
    message: string,
    retryable: boolean,
    retryAfterMs: number | undefined,
    tokensUsed: number,
  ): AttemptOutcome {
    return { kind: "failed", reason: WORK_FAILURE.providerError, message, retryable, retryAfterMs, tokensUsed };
  }

  /** Exponential, jittered so retrying agents spread out, and never shorter than the provider asked. */
  function backoff(retry: number, retryAfterMs: number | undefined): number {
    const exponential = backoffMs * 2 ** (retry - 1) * (0.5 + random() / 2);
    return Math.min(maxBackoffMs, Math.max(exponential, retryAfterMs ?? 0));
  }

  async function work(
    ticket: WorkTicket,
    context: WorkContext,
    signal: AbortSignal,
  ): Promise<WorkResult> {
    let tokensUsed = 0;
    let attempts = 0;
    let last: FailedAttempt | undefined;

    while (attempts < maxAttempts) {
      // Checked before the budget, so a cancelled call spends nothing.
      if (signal.aborted) {
        last = cancelledAttempt();
        break;
      }
      const decision = options.budget?.take() ?? UNLIMITED;
      if (!decision.ok) {
        const message =
          last === undefined ? decision.message : `${decision.message} (after: ${last.message})`;
        return {
          ok: false,
          reason: WORK_FAILURE.budgetExhausted,
          message,
          tokensUsed,
          attempts,
          retryAt: decision.retryAt,
        };
      }

      attempts += 1;
      const outcome = await attempt(ticket, context, signal);
      tokensUsed += outcome.kind === "ok" ? outcome.output.tokensUsed : outcome.tokensUsed;
      if (outcome.kind === "ok") {
        return { ok: true, ...outcome.output, tokensUsed, attempts };
      }

      last = outcome;
      if (!outcome.retryable || attempts >= maxAttempts) {
        break;
      }
      const waited = whenAborted(signal);
      await Promise.race([sleep(backoff(attempts, outcome.retryAfterMs), signal), waited.aborted]);
      waited.release();
    }

    return {
      ok: false,
      reason: last?.reason ?? WORK_FAILURE.providerError,
      message: last?.message ?? "no attempt was made",
      tokensUsed,
      attempts,
      retryAt: undefined,
    };
  }

  return {
    async work(ticket, context, signal) {
      try {
        return await work(ticket, context, signal ?? NEVER);
      } catch (error) {
        // Unreachable by construction; the guarantee is worth one more net.
        return {
          ok: false,
          reason: WORK_FAILURE.providerError,
          message: error instanceof Error && error.message !== "" ? error.message : "the work failed",
          tokensUsed: 0,
          attempts: 0,
          retryAt: undefined,
        };
      }
    },
  };
}
