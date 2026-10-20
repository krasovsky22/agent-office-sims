/**
 * The loop between the office's work on an issue and the runner's agent doing
 * it: what the CEO does to the work becomes a command for the agent's slot,
 * and what the slot reports becomes the agent's own moves on the work.
 *
 * Outward, from {@link RunnerWork.changed}, which hears every command that
 * changed the work (`../rooms/workHandlers.ts`), whoever gave it: the board,
 * or the AI manager acting for the CEO.
 *
 * - New work, or work handed to another slot, starts that slot on the issue;
 *   the slot that had it is stopped.
 * - A review sent back is a rework prompt to the slot still holding the
 *   issue, or a start with the same words when it no longer is.
 * - Work sent back to `assigned` starts again from the top: stop, then start.
 * - Work taken back, approved, or finished by GitHub closing the issue stops
 *   the slot, which settles its worktree.
 * - Work the CEO cancelled stops the slot and has it discard the task: its
 *   worktree, branch and pull request go, whatever is in them.
 * - A slot holding an issue on which the office has no unfinished work of its
 *   own, as after the room was closed and opened again, is stopped too, by
 *   {@link RunnerWork.reconcile}: the office's work is the record of what each
 *   agent should be doing, and an agent nobody can see the work of could never
 *   be taken off it. What it had is kept in its worktree, as for any stop,
 *   unless the CEO cancelled that work: a runner that missed the cancel's own
 *   stop, offline at the time, still discards it.
 *
 * Inward, from {@link RunnerWork.receive}, each event the runner reports is
 * applied through the same `applyAs` as the slot's live agent, so the work's
 * rules decide it exactly as they decide anyone's: `started` claims the
 * issue, `pr-opened` attaches the pull request and hands it in for review,
 * and `failed` says why on the work. An event about work the slot no longer
 * holds is refused by those rules and changes nothing. A start the runner
 * refused because its daily budget is spent is also explained to the office,
 * in the AI Manager's voice, since nothing on the board says why the work never
 * began.
 *
 * Nothing here writes to GitHub: the runner's agent opens the pull request,
 * and the server only hears that it did.
 */

import {
  type IssueWork,
  OCCUPANT_KIND,
  type OfficeActor,
  RUNNER_COMMAND_KIND,
  RUNNER_EVENT_KIND,
  RUNNER_REFUSAL,
  type RunnerCommand,
  type RunnerCommandDraft,
  type RunnerPullRequest,
  WORK_ACTION,
  WORK_STATUS,
  actorOf,
  isLiveAgentKey,
  isRunnerWorkEvent,
  liveAgentKey,
  simulatedPullRequestArtifact,
  workKey,
} from "@sim/shared";

import { type WorkChange, type WorkHost, applyAs } from "../rooms/workHandlers.js";
import { type RunnerEventRecord, type RunnerSlotRef, runnerSlotAgentId, runnerSlotOf } from "./runnerLink.js";

/** What the loop needs of the runner link. */
export interface RunnerCommands {
  /** Queues a command for a slot; `undefined` when the runner cannot be given it. */
  enqueue(runnerId: string, draft: RunnerCommandDraft): RunnerCommand | undefined;
  /** Takes back a command its runner has not acked; whether it was still waiting. */
  withdraw(runnerId: string, commandId: string): boolean;
  /** The issue a slot was holding at its runner's last sync. */
  slotIssue(runnerId: string, slotId: string): number | undefined;
  /** Every slot holding an issue at its runner's last sync. */
  heldIssues(): ReadonlyArray<RunnerSlotRef & { readonly issueNumber: number }>;
  /** An issue's link on the project board's repository. */
  issueUrl(issueNumber: number): string;
}

/**
 * Whether a room option is the command channel the server handed over, rather
 * than whatever a client put in its join options under the same name.
 */
export function isRunnerCommands(value: unknown): value is RunnerCommands {
  const candidate = value as Partial<Record<keyof RunnerCommands, unknown>> | null;
  return (
    typeof value === "object" &&
    candidate !== null &&
    typeof candidate.enqueue === "function" &&
    typeof candidate.withdraw === "function" &&
    typeof candidate.slotIssue === "function" &&
    typeof candidate.heldIssues === "function" &&
    typeof candidate.issueUrl === "function"
  );
}

/** The words a slot is sent back to work with. */
export function reworkPrompt(issueNumber: number): string {
  return [
    `The CEO sent your pull request for issue #${issueNumber} back for more work.`,
    "Read what reviewers said on it with `gh pr view --comments`, make the changes, verify and commit them,",
    "then push the same branch so the pull request updates. Don't open a second pull request.",
  ].join(" ");
}

/**
 * What the AI Manager says when a runner refused to start an agent because its
 * daily budget is spent: who could not start on what, the runner's own reason
 * with its numbers, and how to start it once the budget allows. Nothing
 * retries a refused start by itself, so the work stays assigned until the CEO
 * gives it out again.
 */
export function budgetRefusalText(agentName: string, issueNumber: number, title: string, reason: string): string {
  const issue = title === "" ? `#${issueNumber}` : `#${issueNumber} “${title}”`;
  const why = reason === "" ? "the runner's daily budget is spent" : reason.charAt(0).toLowerCase() + reason.slice(1);
  return (
    `${agentName} couldn't start on ${issue}: ${why.replace(/\.$/, "")}. ` +
    "Nothing started, so nothing more was spent. To try again once the runner's RUNNER_DAILY_BUDGET_USD is raised " +
    "or its day turns over, take the work back and assign it again."
  );
}

/**
 * The work's deliverable for a pull request, as the board card shows it. A
 * simulated one says so, with neither its number nor any link, since nothing
 * on GitHub answers to them.
 */
export function pullRequestArtifact(pr: RunnerPullRequest): string {
  if (pr.simulated === true) {
    return simulatedPullRequestArtifact(pr.title);
  }
  return pr.title === "" ? `PR #${pr.number}: ${pr.url}` : `PR #${pr.number}: ${pr.title}, ${pr.url}`;
}

const LIVE_AGENT_PREFIX = liveAgentKey("");

/** A slot holding an issue, as one string. */
function heldKey(runnerId: string, slotId: string, issueNumber: number): string {
  return `${runnerId}:${slotId}#${issueNumber}`;
}

/** The slot an occupant key names, for a runner's live agent. */
export function slotOf(occupantId: string): RunnerSlotRef | undefined {
  return isLiveAgentKey(occupantId) ? runnerSlotOf(occupantId.slice(LIVE_AGENT_PREFIX.length)) : undefined;
}

export interface RunnerWorkOptions {
  readonly host: WorkHost;
  readonly runner: RunnerCommands;
  /** Where a command the runner was given, or could not be, is written down. */
  readonly log?: (name: string, detail: Record<string, string | number>) => void;
  /** Says something to the office as the AI Manager; nobody hears it by default. */
  readonly announce?: (text: string) => void;
}

export class RunnerWork {
  private readonly log: NonNullable<RunnerWorkOptions["log"]>;
  /** Slots already told to stop holding an issue the office has no work of theirs on, as `runner:slot#issue`. */
  private readonly orphans = new Set<string>();
  /** Slots whose work the CEO cancelled, as `runner:slot#issue`, so a later stop for it discards too. */
  private readonly cancelled = new Set<string>();

  public constructor(private readonly options: RunnerWorkOptions) {
    this.log = options.log ?? (() => undefined);
  }

  /** A command changed the work: tells the slots it concerns. Agents' own moves concern none. */
  public changed(change: WorkChange): void {
    if (change.actor.kind === OCCUPANT_KIND.liveAgent) {
      return;
    }
    const { before, work, command, actor } = change;
    switch (command.action) {
      case WORK_ACTION.assign:
        if (before === undefined) {
          this.start(work, actor, "");
        } else if (before.assigneeId !== work.assigneeId) {
          this.stop(before.assigneeId, work.issueNumber, `#${work.issueNumber} went to ${this.nameOf(work.assigneeId)}`);
          this.start(work, actor, "");
        }
        return;
      case WORK_ACTION.release:
        this.stop(work.assigneeId, work.issueNumber, "the CEO took the work back");
        return;
      case WORK_ACTION.cancel: {
        const slot = slotOf(work.assigneeId);
        if (slot !== undefined) {
          this.cancelled.add(heldKey(slot.runnerId, slot.slotId, work.issueNumber));
        }
        this.stop(work.assigneeId, work.issueNumber, "the CEO cancelled the task", true);
        return;
      }
      case WORK_ACTION.moveStatus:
        if (before === undefined || before.status === work.status) {
          return;
        }
        if (work.status === WORK_STATUS.done) {
          this.stop(work.assigneeId, work.issueNumber, "the work is done");
        } else if (before.status === WORK_STATUS.review && work.status === WORK_STATUS.in_progress) {
          this.rework(work, actor);
        } else if (before.status === WORK_STATUS.in_progress && work.status === WORK_STATUS.assigned) {
          this.stop(work.assigneeId, work.issueNumber, "the CEO asked for a fresh start");
          this.start(work, actor, "");
        }
        return;
      default:
        return;
    }
  }

  /**
   * Stops every slot holding an issue whose unfinished work, here, is not its
   * own, once for each slot and issue. Synchronous and small, so the room can
   * run it on its tick.
   */
  public reconcile(): void {
    const held = this.options.runner.heldIssues();
    const current = new Set<string>();
    for (const { runnerId, slotId, issueNumber } of held) {
      const key = heldKey(runnerId, slotId, issueNumber);
      current.add(key);
      const agentId = liveAgentKey(runnerSlotAgentId(runnerId, slotId));
      const work = this.options.host.state.work.get(workKey(issueNumber));
      if ((work !== undefined && work.assigneeId === agentId && work.status !== WORK_STATUS.done) || this.orphans.has(key)) {
        continue;
      }
      this.orphans.add(key);
      const cancelled = this.cancelled.delete(key);
      this.stop(agentId, issueNumber, cancelled ? "the CEO cancelled the task" : "the office has no work for it on this issue", cancelled);
    }
    for (const key of this.orphans) {
      if (!current.has(key)) {
        this.orphans.delete(key);
      }
    }
  }

  /** GitHub closed the issue: the work was released, or shipped as done. Either way its slot is finished with it. */
  public ended(work: IssueWork, reason: string): void {
    this.stop(work.assigneeId, work.issueNumber, reason);
  }

  /**
   * Applies what the runners reported about issue work, each event as its
   * slot's live agent. A standing task's events are not the work's: the
   * room's `StandingAnnouncer` has them.
   */
  public receive(records: readonly RunnerEventRecord[]): void {
    for (const { runnerId, event } of records) {
      if (!isRunnerWorkEvent(event)) {
        continue;
      }
      const occupant = this.options.host.state.occupants.get(liveAgentKey(runnerSlotAgentId(runnerId, event.slotId)));
      if (occupant === undefined) {
        continue;
      }
      const agent = actorOf(occupant);
      const issueNumber = event.issueNumber;
      switch (event.kind) {
        case RUNNER_EVENT_KIND.started:
          applyAs(this.options.host, agent, { action: WORK_ACTION.claim, payload: { issueNumber } });
          break;
        case RUNNER_EVENT_KIND.prOpened: {
          if (event.pr === undefined) {
            break;
          }
          const artifact = pullRequestArtifact(event.pr);
          const attached = applyAs(this.options.host, agent, {
            action: WORK_ACTION.attachOutput,
            payload: { issueNumber, artifact },
          });
          if (attached.ok) {
            applyAs(this.options.host, agent, { action: WORK_ACTION.handIn, payload: { issueNumber } });
          }
          break;
        }
        case RUNNER_EVENT_KIND.failed:
          applyAs(this.options.host, agent, {
            action: WORK_ACTION.note,
            payload: { issueNumber, text: event.message === "" ? "The agent stopped working on it." : event.message },
          });
          if (event.refusal === RUNNER_REFUSAL.budget) {
            const title = this.options.host.state.work.get(workKey(issueNumber))?.title ?? "";
            this.options.announce?.(budgetRefusalText(occupant.name, issueNumber, title, event.message));
          }
          break;
        case RUNNER_EVENT_KIND.finished:
          break;
      }
    }
  }

  /** Sends the review back to the slot holding it, or starts it on it again with the same words when it is not. */
  private rework(work: IssueWork, actor: OfficeActor): void {
    const slot = slotOf(work.assigneeId);
    if (slot === undefined) {
      return;
    }
    const text = reworkPrompt(work.issueNumber);
    if (this.options.runner.slotIssue(slot.runnerId, slot.slotId) !== work.issueNumber) {
      this.start(work, actor, text);
      return;
    }
    this.send(work, slot, { kind: RUNNER_COMMAND_KIND.prompt, slotId: slot.slotId, text, requestedBy: this.nameOf(actor.id) });
  }

  private start(work: IssueWork, actor: OfficeActor, note: string): void {
    const slot = slotOf(work.assigneeId);
    if (slot === undefined) {
      return;
    }
    // Given the issue again: its next stop is an ordinary one.
    this.cancelled.delete(heldKey(slot.runnerId, slot.slotId, work.issueNumber));
    this.send(work, slot, {
      kind: RUNNER_COMMAND_KIND.start,
      slotId: slot.slotId,
      issueNumber: work.issueNumber,
      title: work.title === "" ? `Issue #${work.issueNumber}` : work.title,
      url: this.options.runner.issueUrl(work.issueNumber),
      note,
      requestedBy: this.nameOf(actor.id),
    });
  }

  /**
   * Stops a slot's work on one issue. Sent whether or not the slot reported
   * holding it, since a start still on its way would otherwise begin after
   * the work was taken back; naming the issue keeps it from ending any other.
   */
  private stop(assigneeId: string, issueNumber: number, reason: string, discard = false): void {
    const slot = slotOf(assigneeId);
    if (slot === undefined) {
      return;
    }
    const command = this.options.runner.enqueue(slot.runnerId, {
      kind: RUNNER_COMMAND_KIND.stop,
      slotId: slot.slotId,
      reason,
      issueNumber,
      ...(discard ? { discard: true } : {}),
    });
    this.log(command === undefined ? "runner-command-refused" : "runner-command", {
      kind: RUNNER_COMMAND_KIND.stop,
      slot: runnerSlotAgentId(slot.runnerId, slot.slotId),
      issue: issueNumber,
    });
  }

  /**
   * Queues a start or a prompt, and when the runner cannot take it, says so
   * on the work in the agent's own voice, since the agent is who cannot start.
   */
  private send(work: IssueWork, slot: RunnerSlotRef, draft: RunnerCommandDraft): void {
    const command = this.options.runner.enqueue(slot.runnerId, draft);
    this.log(command === undefined ? "runner-command-refused" : "runner-command", {
      kind: draft.kind,
      slot: runnerSlotAgentId(slot.runnerId, slot.slotId),
      issue: work.issueNumber,
    });
    if (command !== undefined) {
      return;
    }
    const occupant = this.options.host.state.occupants.get(work.assigneeId);
    if (occupant !== undefined) {
      applyAs(this.options.host, actorOf(occupant), {
        action: WORK_ACTION.note,
        payload: { issueNumber: work.issueNumber, text: "My runner could not take this; it may be offline. Try again shortly." },
      });
    }
  }

  private nameOf(occupantId: string): string {
    return this.options.host.state.occupants.get(occupantId)?.name ?? "the CEO";
  }
}
