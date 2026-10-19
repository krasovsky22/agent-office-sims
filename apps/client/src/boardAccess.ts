/**
 * What the local player may do about the project board's work, in words the
 * HUD can show.
 *
 * The decision is not made here. `mayActOnWork` in `@sim/shared` is the rule
 * the server enforces, and this module only asks it the same question about the
 * local player, so a control is disabled exactly when the server would refuse
 * it. Everything a board control needs — whether to offer it, which moves are
 * on offer, and what to say when it is not — comes from this one place, so the
 * board panel has a single import to gate on rather than a role check of its
 * own.
 */

import {
  ISSUE_STATE,
  ISSUE_STATE_REJECTION,
  type IssueState,
  type IssueStateRejection,
  type OfficeActor,
  WORK_REJECTION,
  type WorkAction,
  type WorkData,
  type WorkMove,
  type WorkRejection,
  mayActOnWork,
  mayAssignWork,
  mayChangeIssueState,
  workMoves,
} from "@sim/shared";

/** The local player's standing at the board. */
export interface BoardAccess {
  /** Whether the board is read-only for this player. */
  readonly readOnly: boolean;
  /** One sentence on what this player may do, and why, for the HUD. */
  readonly summary: string;
  /** Whether the board panel offers to hand an open issue to an agent. */
  readonly mayAssign: boolean;
  /**
   * Whether cards can be dragged onto Closed and back onto Open, which closes
   * and reopens the issue on GitHub: the CEO's, while an agent runner that can
   * make the change is connected.
   */
  readonly mayChangeIssueState: boolean;
  /** Why the CEO cannot drag cards to close or reopen them right now; `undefined` when they can, or are not the CEO. */
  readonly issueStateNote: string | undefined;
  /**
   * The moves the board panel offers on `work`, given who is in the office;
   * the shared planner's answer.
   */
  readonly movesFor: (work: WorkData, people: readonly { readonly id: string }[]) => WorkMove[];
}

/** Whether `actor` may perform `action`; the server's own rule. */
export function mayAct(actor: OfficeActor, action: WorkAction): boolean {
  return mayActOnWork({ actor, action });
}

/**
 * The local player's access, from their actor and the CEO's name.
 *
 * Read-only means every CEO-only action is refused; checked against the rule
 * rather than the role, so the summary cannot claim a control is open that the
 * server would reject.
 *
 * @param ceoName `undefined` while the roster has not shown who holds the role.
 * @param issuesWritable the replicated `issuesWritable`: whether an agent
 *   runner that can close and reopen issues is connected.
 */
export function boardAccessFor(
  actor: OfficeActor,
  ceoName: string | undefined,
  issuesWritable = false,
): BoardAccess {
  const mayAssign = mayAssignWork(actor);
  const mayChange = issuesWritable && mayChangeIssueState(actor);
  const issueStateNote =
    mayChangeIssueState(actor) && !issuesWritable
      ? "Dragging a card to Closed or back to Open closes or reopens it on GitHub, which an agent runner does; none that can is connected."
      : undefined;
  const readOnly = !mayAssign;
  const movesFor = (work: WorkData, people: readonly { readonly id: string }[]): WorkMove[] =>
    workMoves(work, actor, (id) => people.some((person) => person.id === id));
  if (!readOnly) {
    return {
      readOnly,
      summary: mayChange
        ? "You are the CEO: you hand the project board's issues to agents, approve their work, " +
          "and close or reopen an issue by dragging its card."
        : "You are the CEO: you hand the project board's issues to agents, and approve their work.",
      mayAssign,
      mayChangeIssueState: mayChange,
      issueStateNote,
      movesFor,
    };
  }
  const who = ceoName === undefined ? "the CEO" : `the CEO, ${ceoName},`;
  return {
    readOnly,
    mayAssign,
    mayChangeIssueState: mayChange,
    issueStateNote,
    movesFor,
    summary:
      `The project board is read-only for you: only ${who} can hand issues to agents, ` +
      "approve their work or send it back. You can read it and ask the manager about it.",
  };
}

const REJECTION_TEXT: Readonly<Record<WorkRejection, string>> = {
  [WORK_REJECTION.forbidden]: "Only the CEO can do that.",
  [WORK_REJECTION.unknownIssue]: "That issue is not open on the project board any more.",
  [WORK_REJECTION.noWork]: "Nobody is working that issue any more.",
  [WORK_REJECTION.illegalTransition]: "That work cannot move there from where it is now.",
  [WORK_REJECTION.unknownAssignee]: "That agent is no longer in the office.",
  [WORK_REJECTION.missingArtifact]: "That work has no deliverable to hand in yet.",
  [WORK_REJECTION.restricted]: "That issue is restricted from the coding agents.",
};

/**
 * What to tell the player when the server refuses one of their commands.
 *
 * @param restrictLabel the office's restriction label, the replicated
 *   `agentRestrictLabel`, so an issue refused for carrying it says which.
 */
export function rejectionText(rejection: WorkRejection, restrictLabel = ""): string {
  if (rejection === WORK_REJECTION.restricted && restrictLabel !== "") {
    return `That issue is restricted from the coding agents: a maintainer has to remove its ${restrictLabel} label first.`;
  }
  return REJECTION_TEXT[rejection];
}

/**
 * What to tell the CEO when a card they dragged did not change on GitHub, and
 * has gone back to where it was.
 */
export function issueStateRejectionText(rejection: IssueStateRejection, issueNumber: number, state: IssueState): string {
  const verb = state === ISSUE_STATE.closed ? "close" : "reopen";
  switch (rejection) {
    case ISSUE_STATE_REJECTION.forbidden:
      return `Only the CEO can ${verb} issues.`;
    case ISSUE_STATE_REJECTION.unavailable:
      return `#${issueNumber} was not ${state === ISSUE_STATE.closed ? "closed" : "reopened"}: no agent runner that can change issues on GitHub is connected.`;
    case ISSUE_STATE_REJECTION.unknownIssue:
      return `#${issueNumber} is not where the board showed it any more; nothing was changed.`;
    case ISSUE_STATE_REJECTION.busy:
      return `#${issueNumber} is already being changed on GitHub; wait for that first.`;
    case ISSUE_STATE_REJECTION.refused:
      return `GitHub refused to ${verb} #${issueNumber}. The runner's GitHub identity may not be allowed to change issues; a GitHub App needs Issues: Read and write.`;
    case ISSUE_STATE_REJECTION.unreachable:
      return `Neither the agent runner nor GitHub answered in time, so #${issueNumber} may not have been ${state === ISSUE_STATE.closed ? "closed" : "reopened"}; the board shows GitHub's state on its next refresh.`;
  }
}
