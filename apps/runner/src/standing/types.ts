/**
 * What the standing tasks' scheduler (`./scheduler.ts`) needs from whatever
 * does a run: review one pull request, or carry out one firing of a
 * schedule, on a slot it has been lent, and say what came of it.
 *
 * The scheduler owns everything around a run: the ledger, the caps, the
 * slot, preemption and the events. A run only does its one piece of work
 * and returns; it never throws, and it stops as soon as its `signal` aborts.
 */

import type { StandingTaskSpec } from "@sim/shared";

import type { StandingSlotLease } from "../slots.js";

/** One run, as the scheduler hands it over. */
export interface StandingJob {
  readonly spec: StandingTaskSpec;
  /** The CEO who set the task up. */
  readonly requestedBy: string;
  /** The slot it runs on: its screen, activity line and the runner's books. */
  readonly lease: StandingSlotLease;
  /** Aborts when the slot is taken back, the task is removed, or the runner stops. */
  readonly signal: AbortSignal;
  /** The pull request a `pr-review` run reviews. */
  readonly pr?: { readonly number: number; readonly title: string; readonly headSha: string } | undefined;
  /** The firing a `schedule` run is for, epoch ms. */
  readonly firedAt?: number | undefined;
}

/** What came of one run. */
export interface StandingRunResult {
  readonly outcome: "reviewed" | "completed" | "simulated" | "failed" | "skipped";
  /** All it cost, in US dollars. */
  readonly costUsd: number;
  /** A schedule's result, or why it failed or was skipped; `""` for nothing. */
  readonly message: string;
  /** The review comment, once posted. */
  readonly commentId?: number | undefined;
}

export interface StandingRunners {
  /** Pretend runs, as the mock's are: nothing is posted, read or spent for real. */
  readonly simulated: boolean;
  /** Shortest time between two looks at GitHub's pull requests, whatever a task asks. */
  readonly minPollIntervalMs: number;
  review(job: StandingJob): Promise<StandingRunResult>;
  schedule(job: StandingJob): Promise<StandingRunResult>;
}
