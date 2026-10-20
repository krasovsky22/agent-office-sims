/**
 * What every kind of run on a slot shares: an issue's task, a desk session,
 * and a standing task's run.
 *
 * Each books what its agent says it cost in the runner's ledger, shows what
 * its agent prints on the slot's screen, and, for a task and a desk session,
 * takes the CEO's prompt only while its agent waits at its prompt. Kept apart
 * from `./slots.ts` so the pool and `./deskSessions.ts` say each of these once.
 */

import {
  RUNNER_PROMPT_OUTCOME,
  RUNNER_SLOT_STATUS,
  type RunnerPromptOutcomeKind,
  type RunnerSlotStatus,
  formatUsd,
} from "@sim/shared";

import type { AgentReporter, AgentRun } from "./agents/types.js";
import type { SpendLedger } from "./budget.js";
import type { ScreenMirror } from "./terminal.js";

/** A slot's activity once its agent's turn has ended: `idle`, still holding the task. */
export const TURN_DONE = "Turn done";

/** A run of any kind, as far as its screen and its spend go. */
export interface HeldRun {
  /** Cleared the moment it ends, so nothing its agent says afterwards lands. */
  readonly live: boolean;
  /** What its agent has said it cost, in US dollars. */
  spentUsd: number;
}

/**
 * Books what a run has said it cost, all of it rather than since last said,
 * against what it said before.
 *
 * @returns whether it was booked; a total that is not a number is not.
 */
export function bookSpend(ledger: SpendLedger, held: Pick<HeldRun, "spentUsd">, totalUsd: number): boolean {
  if (!Number.isFinite(totalUsd)) {
    return false;
  }
  ledger.add(totalUsd - held.spentUsd);
  held.spentUsd = totalUsd;
  return true;
}

/** What {@link runReporter} needs to book a run's spend and say so. */
export interface RunBooks {
  readonly ledger: SpendLedger;
  readonly debug: (line: string) => void;
  /** Who the spend is said of, `slot-1 on #39`. */
  readonly on: string;
}

/**
 * An agent's reporter, from what the run does with each of its events and the
 * two parts every run shares: what the agent prints goes to the slot's screen
 * while the run is live, and what it says it cost is booked whether or not it
 * still is, since a stopped agent's last turn is paid for too.
 */
export function runReporter(
  screen: ScreenMirror,
  held: HeldRun,
  books: RunBooks,
  events: Omit<AgentReporter, "output" | "spent">,
): AgentReporter {
  return {
    ...events,
    output: (data) => {
      if (held.live) {
        screen.write(data);
      }
    },
    spent: (totalUsd) => {
      if (bookSpend(books.ledger, held, totalUsd)) {
        books.debug(`${books.on} has spent ${formatUsd(totalUsd)}`);
      }
    },
  };
}

/**
 * Whether an agent waits at its prompt, and if not, why.
 *
 * Its turn is done when the slot is idle, or needs a person only because a
 * turn ended with nothing handed in (`missing`); a task's slot still looking
 * for its pull request after a turn (`checking`) is busy until it has. An
 * agent whose wait on a person a prompt answers takes the prompt as that
 * answer.
 *
 * @param agentRun `undefined` while the run cannot take a prompt: it is over,
 *   or still starting.
 */
export function promptOutcome(
  status: RunnerSlotStatus,
  agentRun: AgentRun | undefined,
  run: { readonly checking: boolean; readonly missing: boolean } = { checking: false, missing: false },
): RunnerPromptOutcomeKind {
  if (agentRun?.prompt === undefined) {
    return status === RUNNER_SLOT_STATUS.starting ? RUNNER_PROMPT_OUTCOME.busy : RUNNER_PROMPT_OUTCOME.unavailable;
  }
  switch (status) {
    case RUNNER_SLOT_STATUS.idle:
      return run.checking ? RUNNER_PROMPT_OUTCOME.busy : RUNNER_PROMPT_OUTCOME.delivered;
    case RUNNER_SLOT_STATUS.needsInput:
      return run.missing || agentRun.promptAnswersWait === true ? RUNNER_PROMPT_OUTCOME.delivered : RUNNER_PROMPT_OUTCOME.needsInput;
    case RUNNER_SLOT_STATUS.starting:
    case RUNNER_SLOT_STATUS.working:
      return RUNNER_PROMPT_OUTCOME.busy;
    case RUNNER_SLOT_STATUS.exited:
      return RUNNER_PROMPT_OUTCOME.unavailable;
  }
}
