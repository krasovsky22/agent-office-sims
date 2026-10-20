/**
 * What the AI Manager says about the standing tasks' runs: each review, each
 * scheduled run's result, each pull request the steward brought up to date
 * or merged, and each thing a task left alone, as a templated line in its
 * conversation, the way it says a start the runner refused.
 *
 * Templated rather than the manager's own words because these are facts from
 * the runner, and a link to a review comment must be the one the runner
 * posted: built here from the board's repository and the comment's id, never
 * taken as a URL from the runner. A failure is said once, after its last
 * attempt; a run the task will try again says nothing yet.
 *
 * Synchronous and small, so the room calls it on its tick with the events it
 * drained.
 */

import {
  RUNNER_EVENT_KIND,
  type RunnerStandingRefusedEvent,
  type RunnerStandingRunEvent,
  STANDING_KIND,
  STANDING_OUTCOME,
  formatUsd,
  liveAgentKey,
} from "@sim/shared";

import { type RunnerEventRecord, runnerSlotAgentId } from "./runnerLink.js";

export interface StandingAnnouncerOptions {
  /** A pull request's link on the project board's repository, which every review comment is on. */
  readonly pullUrl: (number: number) => string;
  /** A task's name by id, as the office last heard it; `undefined` for one it never did. */
  readonly taskName: (taskId: string) => string | undefined;
  /** A task's kind by id, as the office last heard it. */
  readonly taskKind?: (taskId: string) => string | undefined;
  /** An occupant's name by key; `undefined` for one who has left. */
  readonly occupantName: (occupantId: string) => string | undefined;
  /** Says it to the office in the AI Manager's voice. */
  readonly announce: (text: string) => void;
  /** Forgets a task a runner was asked to take and refused. */
  readonly refused?: (taskId: string) => void;
}

/** A pull request as the conversation names it: `PR #112 “Add a lift”`. */
function pullText(pr: RunnerStandingRunEvent["pr"]): string {
  if (pr === undefined) {
    return "";
  }
  return pr.title === "" ? `PR #${pr.number}` : `PR #${pr.number} “${pr.title}”`;
}

function lower(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

export class StandingAnnouncer {
  public constructor(private readonly options: StandingAnnouncerOptions) {}

  /** Says what each standing event among `records` means; issue work's events are passed over. */
  public receive(records: readonly RunnerEventRecord[]): void {
    for (const { runnerId, event } of records) {
      if (event.kind === RUNNER_EVENT_KIND.standingRun) {
        const text = this.runText(runnerId, event);
        if (text !== undefined) {
          this.options.announce(text);
        }
      } else if (event.kind === RUNNER_EVENT_KIND.standingRefused) {
        this.options.refused?.(event.taskId);
        this.options.announce(this.refusedText(event));
      }
    }
  }

  /** The line for one run, or `undefined` for one that says nothing yet. */
  public runText(runnerId: string, event: RunnerStandingRunEvent): string | undefined {
    const task = `“${this.options.taskName(event.taskId) ?? "a standing task"}”`;
    const agent =
      event.slotId === undefined ? undefined : this.options.occupantName(liveAgentKey(runnerSlotAgentId(runnerId, event.slotId)));
    const who = agent ?? "An agent";
    const pr = pullText(event.pr);
    const cost = event.costUsd > 0 ? ` (${formatUsd(event.costUsd)})` : "";
    switch (event.outcome) {
      case STANDING_OUTCOME.reviewed: {
        if (event.pr === undefined) {
          return `${who} reviewed for ${task}.`;
        }
        const url = this.options.pullUrl(event.pr.number);
        return `${who} reviewed ${pr}: ${event.commentId === undefined ? url : `${url}#issuecomment-${event.commentId}`}`;
      }
      case STANDING_OUTCOME.resolved:
        return `${who} merged the base into ${pr} for ${task}, resolving its conflicts, and pushed it${cost}: ${event.pr === undefined ? "" : this.options.pullUrl(event.pr.number)}`.trim();
      case STANDING_OUTCOME.merged:
        return `${who} merged ${pr} for ${task}, every required check green: ${event.pr === undefined ? "" : this.options.pullUrl(event.pr.number)}`.trim();
      case STANDING_OUTCOME.completed:
        return `${who} ran ${task}${cost}:\n${event.message}`;
      case STANDING_OUTCOME.simulated:
        return pr === ""
          ? `${who} did a simulated run of ${task}; nothing was read or done.`
          : `${who} did a simulated review of ${pr} for ${task}; nothing was posted on GitHub.`;
      case STANDING_OUTCOME.failed:
        if (!event.final) {
          return undefined;
        }
        return pr === ""
          ? `${task} failed, and won't be tried again until it next fires: ${lower(event.message)}`
          : this.options.taskKind?.(event.taskId) === STANDING_KIND.prSteward
            ? `${task} gave up on ${pr} after its last try: ${lower(event.message)}`
            : `${task} couldn't review ${pr} after its last try: ${lower(event.message)}`;
      case STANDING_OUTCOME.skipped:
        return pr === "" ? undefined : `${task} skipped ${pr}. ${event.message}`.trim();
      case STANDING_OUTCOME.preempted:
        return `${who} gave ${pr === "" ? `its run of ${task}` : `its review of ${pr}`} up to issue work; it runs again on a free slot.`;
      case STANDING_OUTCOME.refusedBudget:
        return `${task} starts nothing more today: ${lower(event.message)}`;
    }
  }

  private refusedText(event: RunnerStandingRefusedEvent): string {
    const name = event.name === "" ? "a standing task" : `“${event.name}”`;
    return `The runner wouldn't take ${name}: ${lower(event.message)}`;
  }
}
