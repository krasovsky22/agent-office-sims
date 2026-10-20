/**
 * The AI manager's thinking: given what the CEO said and what the office looks
 * like, decide what to say back and which work to hand to whom.
 *
 * Where the answer comes from is a {@link ManagerPlanner} — rules over the
 * live state (`./rulePlanner.ts`), or a language model (`./modelPlanner.ts`) —
 * which makes one attempt and may throw. Everything that makes an attempt safe
 * lives here once: the call budget, the per-attempt timeout, bounded retry with
 * backoff, and cancellation. And the contract is that **advise always
 * resolves, never rejects**, because whatever calls it sits on the path that
 * feeds the room.
 *
 * A plan only says what the manager wants done. Nothing here touches the
 * board: the room's manager carries a plan out afterwards, synchronously and
 * through the board's own rules, so a model can propose an assignment but never
 * make one the CEO could not.
 *
 * `advise` takes seconds with a model and must never be awaited inside the
 * simulation tick; the manager's own loop calls it.
 */

import type { ManagerEntry } from "@sim/shared";

import type { BudgetDecision, CallBudget } from "./budget.js";
import { ADVICE_FAILURE, type AdviceFailureReason, PlannerError } from "./plannerError.js";
import type { OfficeView } from "./officeView.js";

/**
 * What a plan names as the agent when the CEO asked for "a coding agent"
 * without naming one: whichever of the runners' coding agents is free.
 */
export const ANY_CODING_AGENT = "a coding agent";

/**
 * One piece of work the manager wants handed out.
 *
 * Both fields are as the planner wrote them — `#39` or `PR #40`, an agent's
 * id or name, {@link ANY_CODING_AGENT}, or `""` for whoever is free — and are
 * resolved against the live office when the plan is carried out, not trusted.
 */
export interface PlannedAssignment {
  readonly work: string;
  readonly agent: string;
}

/**
 * One thing the manager wants done about a standing task, as the planner
 * wrote it: carried out afterwards through the office's one gate for them
 * (`../agents/standingControl.ts`), with the CEO as the actor, never trusted.
 * `task` names an existing task by its id, its name, or "pull requests" for
 * the pull request watch.
 */
export type PlannedStanding =
  | { readonly action: "watch-pull-requests" }
  | { readonly action: "steward-pull-requests" }
  | { readonly action: "schedule"; readonly cron: string; readonly instruction: string }
  | { readonly action: "pause" | "resume" | "remove" | "check-now"; readonly task: string }
  /** How often comes from the CEO's own message, never the plan, as a schedule's does. */
  | { readonly action: "reschedule"; readonly task: string };

/** The recurring tasks an agent can be hired for, rather than an issue. */
export const STANDING_ROLES = ["pr-steward", "pr-review", "schedule"] as const;

export type StandingRole = (typeof STANDING_ROLES)[number];

/**
 * A new coding agent the manager wants hired for one issue, or for a
 * recurring task, with the profile it wrote for it. As the planner wrote it,
 * and resolved and checked against the live office when the plan is carried
 * out (`./hire.ts`): `work` as an assignment's is, `""` for a standing hire,
 * and an empty name, title or description is left to the office to fill.
 */
export interface PlannedHire {
  readonly work: string;
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** The recurring task it is hired for instead of an issue, which is set up to run on it alone. */
  readonly standing?: StandingRole | undefined;
}

/** The moves on work in hand the project board offers the CEO, as a plan names them. */
export const WORK_MOVES = ["approve", "send-back", "take-back", "start-again"] as const;

export type WorkMoveKind = (typeof WORK_MOVES)[number];

/**
 * One move the manager wants made on work an agent has, as the planner wrote
 * it: carried out afterwards through the work's rules with the CEO as the
 * actor (`./workMoves.ts`), never trusted. `work` names it as an assignment's
 * does; `note` is, for a send-back, the CEO's words on what to change, which
 * go to the agent with its rework, and `""` otherwise.
 */
export interface PlannedWorkMove {
  readonly move: WorkMoveKind;
  readonly work: string;
  readonly note: string;
}

/** What a plan asks of the standup: call one, or end the one that is on. */
export type PlannedStandup = "start" | "end";

export interface ManagerPlan {
  /** What the manager says, before the outcome of any assignment is added. */
  readonly reply: string;
  readonly assignments: readonly PlannedAssignment[];
  /** New agents to hire, each for one issue; none when left out. */
  readonly hires?: readonly PlannedHire[];
  /** Work in hand to approve, send back, take back or start again; none when left out. */
  readonly moves?: readonly PlannedWorkMove[];
  /** Standing tasks to set up, pause, resume, remove or check; none when left out. */
  readonly standing?: readonly PlannedStanding[];
  /** Absent for a plan that leaves the standup alone. */
  readonly standup?: PlannedStandup | undefined;
  /** Model tokens spent; `0` for the rules. */
  readonly tokensUsed: number;
}

/** Everything a planner is given. */
export interface ManagerRequest {
  /** The CEO's message, sanitized. */
  readonly message: string;
  readonly ceoName: string;
  readonly view: OfficeView;
  /** The conversation before this message, oldest first. */
  readonly history: readonly ManagerEntry[];
}

/** One attempt at a plan. It should stop when `signal` aborts. */
export type ManagerPlanner = (request: ManagerRequest, signal: AbortSignal) => Promise<ManagerPlan>;

export type AdviceResult =
  | { readonly ok: true; readonly plan: ManagerPlan; readonly attempts: number }
  | {
      readonly ok: false;
      readonly reason: AdviceFailureReason;
      /** Readable, and safe to show: it never carries a credential. */
      readonly message: string;
      readonly attempts: number;
      readonly tokensUsed: number;
    };

export interface ManagerAdvisor {
  /** Whether a model is behind it, for the boot log and the manager's own words. */
  readonly mode: "rules" | "model";
  /** Resolves with a plan or a structured failure. Never rejects. */
  advise(request: ManagerRequest, signal?: AbortSignal): Promise<AdviceResult>;
}

export interface ManagerAdvisorOptions {
  readonly planner: ManagerPlanner;
  readonly mode: ManagerAdvisor["mode"];
  /** Absent means unlimited, which only a planner that spends nothing should be given. */
  readonly budget?: CallBudget | undefined;
  /** How long one attempt may take before it counts as timed out. */
  readonly timeoutMs?: number;
  /** Attempts per message, the first included. */
  readonly maxAttempts?: number;
  /** Wait before the first retry; it doubles on each one after. */
  readonly backoffMs?: number;
  /** Ceiling on any one wait, a provider's own `retry-after` included. */
  readonly maxBackoffMs?: number;
  /** Injected so a test need not wait out real backoff. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Injected so a test can pin the jitter. In `[0, 1)`. */
  readonly random?: () => number;
}

/**
 * A minute: an answer about the office is a short read of a few kilobytes of
 * state, and someone is standing at the desk waiting for it.
 */
const DEFAULT_TIMEOUT_MS = 60_000;

/** One call and one retry: a conversation should fail fast and be asked again. */
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_BACKOFF_MS = 2_000;
const DEFAULT_MAX_BACKOFF_MS = 15_000;

const NEVER = new AbortController().signal;
const UNLIMITED: BudgetDecision = { ok: true };

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

type Attempt =
  | { readonly kind: "ok"; readonly plan: ManagerPlan }
  | {
      readonly kind: "failed";
      readonly reason: typeof ADVICE_FAILURE.timeout | typeof ADVICE_FAILURE.providerError | typeof ADVICE_FAILURE.cancelled;
      readonly message: string;
      readonly retryable: boolean;
      readonly retryAfterMs: number | undefined;
      readonly tokensUsed: number;
    };

const TIMED_OUT = Symbol("timed out");
const CANCELLED = Symbol("cancelled");

export function createManagerAdvisor(options: ManagerAdvisorOptions): ManagerAdvisor {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  async function attempt(request: ManagerRequest, cancel: AbortSignal): Promise<Attempt> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(TIMED_OUT);
      }, timeoutMs);
    });
    let onCancel: (() => void) | undefined;
    const cancelled = new Promise<typeof CANCELLED>((resolve) => {
      onCancel = () => {
        controller.abort();
        resolve(CANCELLED);
      };
      if (cancel.aborted) {
        onCancel();
      } else {
        cancel.addEventListener("abort", onCancel, { once: true });
      }
    });
    // Started inside a chain so a synchronous throw lands in the catch, and
    // handled at once so a rejection after losing the race is not unhandled.
    const pending = Promise.resolve().then(() => options.planner(request, controller.signal));
    pending.catch(() => undefined);

    try {
      const outcome = await Promise.race([pending, deadline, cancelled]);
      if (outcome === CANCELLED) {
        return failure(ADVICE_FAILURE.cancelled, "the question was withdrawn", false, undefined, 0);
      }
      if (outcome === TIMED_OUT) {
        return failure(ADVICE_FAILURE.timeout, `no answer within ${Math.round(timeoutMs / 1000)}s`, true, undefined, 0);
      }
      if (typeof outcome.reply !== "string" || outcome.reply.trim() === "") {
        return failure(ADVICE_FAILURE.providerError, "the answer was empty", false, undefined, outcome.tokensUsed);
      }
      return { kind: "ok", plan: outcome };
    } catch (error) {
      if (cancel.aborted) {
        return failure(ADVICE_FAILURE.cancelled, "the question was withdrawn", false, undefined, 0);
      }
      if (controller.signal.aborted) {
        return failure(ADVICE_FAILURE.timeout, `no answer within ${Math.round(timeoutMs / 1000)}s`, true, undefined, 0);
      }
      if (error instanceof PlannerError) {
        return failure(ADVICE_FAILURE.providerError, error.message, error.retryable, error.retryAfterMs, error.tokensUsed);
      }
      const message = error instanceof Error && error.message !== "" ? error.message : "the planner failed";
      return failure(ADVICE_FAILURE.providerError, message, false, undefined, 0);
    } finally {
      clearTimeout(timer);
      if (onCancel !== undefined) {
        cancel.removeEventListener("abort", onCancel);
      }
    }
  }

  function failure(
    reason: Extract<Attempt, { kind: "failed" }>["reason"],
    message: string,
    retryable: boolean,
    retryAfterMs: number | undefined,
    tokensUsed: number,
  ): Attempt {
    return { kind: "failed", reason, message, retryable, retryAfterMs, tokensUsed };
  }

  function backoff(retry: number, retryAfterMs: number | undefined): number {
    const exponential = backoffMs * 2 ** (retry - 1) * (0.5 + random() / 2);
    return Math.min(maxBackoffMs, Math.max(exponential, retryAfterMs ?? 0));
  }

  async function advise(request: ManagerRequest, signal: AbortSignal): Promise<AdviceResult> {
    let tokensUsed = 0;
    let attempts = 0;
    let last: Extract<Attempt, { kind: "failed" }> | undefined;
    while (attempts < maxAttempts) {
      if (signal.aborted) {
        return { ok: false, reason: ADVICE_FAILURE.cancelled, message: "the question was withdrawn", attempts, tokensUsed };
      }
      const decision = options.budget?.take() ?? UNLIMITED;
      if (!decision.ok) {
        return { ok: false, reason: ADVICE_FAILURE.budgetExhausted, message: decision.message, attempts, tokensUsed };
      }
      attempts += 1;
      const outcome = await attempt(request, signal);
      if (outcome.kind === "ok") {
        return { ok: true, plan: { ...outcome.plan, tokensUsed: tokensUsed + outcome.plan.tokensUsed }, attempts };
      }
      tokensUsed += outcome.tokensUsed;
      last = outcome;
      if (!outcome.retryable || attempts >= maxAttempts) {
        break;
      }
      await sleep(backoff(attempts, outcome.retryAfterMs), signal);
    }
    return {
      ok: false,
      reason: last?.reason ?? ADVICE_FAILURE.providerError,
      message: last?.message ?? "no attempt was made",
      attempts,
      tokensUsed,
    };
  }

  return {
    mode: options.mode,
    async advise(request, signal) {
      try {
        return await advise(request, signal ?? NEVER);
      } catch (error) {
        // Unreachable by construction; the guarantee is worth one more net.
        return {
          ok: false,
          reason: ADVICE_FAILURE.providerError,
          message: error instanceof Error && error.message !== "" ? error.message : "the manager failed",
          attempts: 0,
          tokensUsed: 0,
        };
      }
    },
  };
}
