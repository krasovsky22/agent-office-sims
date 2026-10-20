/**
 * The mock agent's standing runs: a script of steps on the slot's screen,
 * five pretend cents a step, that reads, posts and spends nothing for real.
 *
 * It lets a standing task be watched end to end without a real agent: the
 * slot sits down and types, its terminal shows each step, the runner's books
 * and the task's day figures fill, a cap can be run out, and the office says
 * what came of each run, which is always `simulated`. Its pull request
 * watcher still reads the repository's real open pull requests, anonymously
 * and at most every five minutes, so a pull request opened while it watches
 * is what it pretends to review.
 *
 * It reads no pull request's checks, so its steward only ever pretends to
 * review: nothing is resolved, pushed or merged under the mock.
 */

import { STANDING_KIND } from "@sim/shared";

import type { StandingJob, StandingRunResult, StandingRunners } from "./types.js";

/** The pretend US dollars each step costs, as the mock's issue work does. */
export const MOCK_STANDING_STEP_USD = 0.05;

/** Its anonymous look at GitHub, held well inside the 60 an hour GitHub allows an address. */
export const MOCK_POLL_INTERVAL_MS = 5 * 60_000;

const DEFAULT_STEP_MS = 2000;

const BOLD = "\u001b[1m";
const DIM = "\u001b[2m";
const GREEN = "\u001b[32m";
const CYAN = "\u001b[36m";
const RESET = "\u001b[0m";

export interface MockStandingOptions {
  readonly stepMs?: number;
  /** Shortest look at GitHub's pull requests; {@link MOCK_POLL_INTERVAL_MS} by default. */
  readonly minPollIntervalMs?: number;
}

/** Waits `ms`, or less when the run is stopped; says whether it was. */
function wait(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(true);
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve(signal.aborted);
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

async function play(job: StandingJob, heading: string, steps: readonly string[], stepMs: number, done: string): Promise<StandingRunResult> {
  const { lease, signal } = job;
  let spent = 0;
  lease.output(`${heading}\r\n${DIM}for ${job.requestedBy || "the CEO"}, standing task “${job.spec.name}”${RESET}\r\n\r\n`);
  for (const step of steps) {
    if (await wait(stepMs, signal)) {
      return { outcome: "failed", costUsd: spent, message: "Stopped before it finished." };
    }
    spent += MOCK_STANDING_STEP_USD;
    lease.activity(step);
    lease.output(`${CYAN}●${RESET} ${step}\r\n`);
    lease.spent(spent);
  }
  lease.output(`${GREEN}✓ ${done}${RESET}\r\n`);
  return { outcome: "simulated", costUsd: spent, message: "" };
}

export function createMockStandingRunners(options: MockStandingOptions = {}): StandingRunners {
  const stepMs = options.stepMs ?? DEFAULT_STEP_MS;
  return {
    simulated: true,
    minPollIntervalMs: options.minPollIntervalMs ?? MOCK_POLL_INTERVAL_MS,
    review: (job) => {
      const pr = job.pr;
      const heading = `${BOLD}mock review${RESET} of PR #${pr?.number ?? "?"}: ${pr?.title ?? ""}`;
      return play(
        job,
        heading,
        ["Read: .sims-review/pr.json", "Read: .sims-review/pr.diff", "Grep: TODO|FIXME", "Writing the review"],
        stepMs,
        "Simulated review; nothing was posted on GitHub",
      );
    },
    // Never asked for: with no `inspect`, the mock's steward queues neither.
    resolve: (job) => play(job, `${BOLD}mock resolve${RESET} of PR #${job.pr?.number ?? "?"}`, ["Merging the base in"], stepMs, "Simulated; nothing was pushed"),
    merge: (job) => play(job, `${BOLD}mock merge${RESET} of PR #${job.pr?.number ?? "?"}`, ["Reading the checks"], stepMs, "Simulated; nothing was merged"),
    schedule: async (job) => {
      const instruction = job.spec.kind === STANDING_KIND.schedule ? job.spec.instruction : "";
      const result = await play(
        job,
        `${BOLD}mock run${RESET} of “${job.spec.name}”\r\n${DIM}> ${instruction}${RESET}`,
        ["Reading the instruction", "Glob: **/*.md", "Writing the result"],
        stepMs,
        "Simulated run; nothing was read or done",
      );
      return result.outcome === "simulated"
        ? { ...result, message: `A simulated run: nothing was read or done. Asked: “${instruction}”` }
        : result;
    },
  };
}
