/**
 * What the standing tasks' scheduler (`./scheduler.ts`) needs from whatever
 * does a run: review one pull request, resolve its conflicts or merge it for
 * the steward, or carry out one firing of a schedule, on a slot it has been
 * lent, and say what came of it; and, for the steward, read a pull request's
 * merge state and checks.
 *
 * The scheduler owns everything around a run: the ledger, the caps, the
 * slot, preemption, the events and the run's record. A run only does its one
 * piece of work and returns; it never throws, and it stops as soon as its
 * `signal` aborts.
 */

import type { PullState, StandingTaskSpec } from "@sim/shared";

import type { StandingSlotLease } from "../slots.js";

/** What one run does: a pull request's review, its conflicts resolved or its merge, or a schedule's firing. */
export type StandingStep = "review" | "resolve" | "merge" | "run";

/** One run, as the scheduler hands it over. */
export interface StandingJob {
  readonly spec: StandingTaskSpec;
  readonly step: StandingStep;
  /** The CEO who set the task up. */
  readonly requestedBy: string;
  /** The slot it runs on: its screen, activity line and the runner's books. */
  readonly lease: StandingSlotLease;
  /** Aborts when the slot is taken back, the task is removed, or the runner stops. */
  readonly signal: AbortSignal;
  /** The pull request a review, resolve or merge is for: its head commit as the task last saw it. */
  readonly pr?: { readonly number: number; readonly title: string; readonly headSha: string } | undefined;
  /** The firing a `schedule` run is for, epoch ms. */
  readonly firedAt?: number | undefined;
}

/** What came of one run. */
export interface StandingRunResult {
  readonly outcome: "reviewed" | "resolved" | "merged" | "completed" | "simulated" | "failed" | "skipped";
  /** All it cost, in US dollars. */
  readonly costUsd: number;
  /** A schedule's result, a review's text, what a merge or resolve did, or why it failed or was skipped; `""` for nothing. */
  readonly message: string;
  /** The review comment, once posted. */
  readonly commentId?: number | undefined;
  /** A failure trying the run again cannot get past: it is the event's last, whatever attempts are left. */
  readonly final?: boolean | undefined;
}

export interface StandingRunners {
  /** Pretend runs, as the mock's are: nothing is posted, read or spent for real. */
  readonly simulated: boolean;
  /** Shortest time between two looks at GitHub's pull requests, whatever a task asks. */
  readonly minPollIntervalMs: number;
  review(job: StandingJob): Promise<StandingRunResult>;
  schedule(job: StandingJob): Promise<StandingRunResult>;
  /** Merges the base branch into the pull request's own, its conflicts resolved, and pushes it. */
  resolve(job: StandingJob): Promise<StandingRunResult>;
  /** Merges the pull request, asking the merge gate again first. */
  merge(job: StandingJob): Promise<StandingRunResult>;
  /**
   * A pull request's merge state and checks, for the steward. Left out by a
   * runner that reads none, the mock's, whose steward then only reviews.
   * Rejects with why when GitHub could not be asked.
   */
  readonly inspect?: ((number: number) => Promise<PullState>) | undefined;
}
