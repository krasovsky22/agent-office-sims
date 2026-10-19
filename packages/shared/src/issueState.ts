/**
 * Closing and reopening the project board's issues on GitHub: who may, which
 * issues, and the words both sides use about it.
 *
 * The CEO drags an issue card from one column of the board's close-up to
 * another; dropping an open issue on Closed closes it on GitHub, and dropping a
 * closed one on Open reopens it. The game server never writes to GitHub, so
 * it hands the change to a connected agent runner
 * (`apps/server/src/rooms/issueStateHandlers.ts`), which makes it with its own
 * GitHub identity, and the board shows it once the feed next polls; this module is the part both sides need, so the client
 * offers exactly the drops the server will take and the server refuses the
 * rest with a reason the client can show.
 *
 * The rule is the work's: whoever may hand the board's issues to agents may
 * change their state, so it asks `mayAssignWork` rather than keeping a role
 * check of its own.
 */

import { type ProjectBoardSnapshot, openBoardIssue } from "./projectBoard.js";
import { type OfficeActor, mayAssignWork } from "./work.js";

/** The two states an issue has on GitHub. */
export const ISSUE_STATE = {
  open: "open",
  closed: "closed",
} as const;

export type IssueState = (typeof ISSUE_STATE)[keyof typeof ISSUE_STATE];

export function isIssueState(value: unknown): value is IssueState {
  return value === ISSUE_STATE.open || value === ISSUE_STATE.closed;
}

/** Why an issue's state was not changed. Refusal changes nothing on GitHub. */
export const ISSUE_STATE_REJECTION = {
  /** Only someone who may hand out the board's work may change it. */
  forbidden: "forbidden",
  /** No agent runner that can make the change is connected. */
  unavailable: "unavailable",
  /** The board does not carry that issue, or it is already in that state. */
  unknownIssue: "unknown-issue",
  /** A change to that issue is already on its way to GitHub. */
  busy: "busy",
  /** GitHub answered, and said no: most often a runner identity that may only read issues. */
  refused: "refused",
  /** The runner or GitHub did not answer in time. */
  unreachable: "unreachable",
} as const;

export type IssueStateRejection = (typeof ISSUE_STATE_REJECTION)[keyof typeof ISSUE_STATE_REJECTION];

/**
 * Whether an actor may close or reopen the board's issues. **The one gate.**
 *
 * The server checks it on every command; the client asks it only to decide
 * whether cards can be picked up at all.
 */
export function mayChangeIssueState(actor: OfficeActor): boolean {
  return mayAssignWork(actor);
}

/** What a client sends to close or reopen an issue. */
export interface IssueStateMessage {
  readonly issueNumber: number;
  readonly state: IssueState;
}

/** What the server answers the sender, once GitHub has, or once it refused without asking. */
export interface IssueStateResultEvent {
  readonly issueNumber: number;
  readonly state: IssueState;
  /** Absent when GitHub made the change. */
  readonly rejection?: IssueStateRejection;
}

/**
 * Whether the board shows an issue that can be moved to `state`: an open issue
 * to close, or a closed one to reopen.
 *
 * Read off the snapshot the board is showing, so a stale one can still be
 * acted on; GitHub has the last word, and refuses or ignores a change that no
 * longer makes sense.
 */
export function isIssueStateChange(
  snapshot: ProjectBoardSnapshot | undefined,
  issueNumber: number,
  state: IssueState,
): boolean {
  if (snapshot === undefined) {
    return false;
  }
  return state === ISSUE_STATE.closed
    ? openBoardIssue(snapshot, issueNumber) !== undefined
    : snapshot.closed.some((issue) => issue.number === issueNumber);
}

/** Everything the gate reads, gathered so the server and a test pass the same thing. */
export interface IssueStateContext {
  readonly actor: OfficeActor;
  readonly board: ProjectBoardSnapshot | undefined;
  /** Whether an agent runner that can make the change is connected. */
  readonly writable: boolean;
}

/**
 * Why a change would be refused before GitHub is asked, or `undefined` when it
 * should be asked.
 */
export function issueStateRejection(
  message: IssueStateMessage,
  context: IssueStateContext,
): IssueStateRejection | undefined {
  if (!mayChangeIssueState(context.actor)) {
    return ISSUE_STATE_REJECTION.forbidden;
  }
  if (!context.writable) {
    return ISSUE_STATE_REJECTION.unavailable;
  }
  if (!isIssueStateChange(context.board, message.issueNumber, message.state)) {
    return ISSUE_STATE_REJECTION.unknownIssue;
  }
  return undefined;
}
