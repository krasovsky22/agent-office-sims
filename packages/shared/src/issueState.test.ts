/**
 * Closing and reopening the board's issues: the gate, which drops the board
 * shows, and the payload parser.
 */

import { describe, expect, it } from "vitest";

import {
  ISSUE_STATE,
  ISSUE_STATE_REJECTION,
  type IssueStateContext,
  isIssueStateChange,
  issueStateRejection,
  mayChangeIssueState,
} from "./issueState.js";
import { parseIssueStateMessage } from "./messages.js";
import { type BoardIssue, EMPTY_BOARD_LISTS, type ProjectBoardSnapshot } from "./projectBoard.js";
import type { OfficeActor } from "./work.js";

function issue(number: number, closedAt: number | null = null): BoardIssue {
  return { number, title: `Issue ${number}`, body: "", labels: [], assignees: [], pullRequests: [], closedAt };
}

const board: ProjectBoardSnapshot = {
  ...EMPTY_BOARD_LISTS,
  open: [issue(1)],
  inProgress: [issue(2)],
  closed: [issue(3, 1_000)],
  counts: { open: 1, inProgress: 1, pullRequests: 0 },
  repository: "owner/name",
  updatedAt: 1_000,
  stale: false,
};

const ceo: OfficeActor = { id: "ceo", kind: "human", isCeo: true };
const executive: OfficeActor = { id: "exec", kind: "human", isCeo: false };

function context(overrides: Partial<IssueStateContext> = {}): IssueStateContext {
  return { actor: ceo, board, writable: true, ...overrides };
}

describe("mayChangeIssueState", () => {
  it("is the CEO's, like handing out the work", () => {
    expect(mayChangeIssueState(ceo)).toBe(true);
    expect(mayChangeIssueState(executive)).toBe(false);
  });
});

describe("isIssueStateChange", () => {
  it("closes an open or in-progress issue and reopens a closed one", () => {
    expect(isIssueStateChange(board, 1, ISSUE_STATE.closed)).toBe(true);
    expect(isIssueStateChange(board, 2, ISSUE_STATE.closed)).toBe(true);
    expect(isIssueStateChange(board, 3, ISSUE_STATE.open)).toBe(true);
  });

  it("refuses a move to the state the issue is already in, or an issue the board lacks", () => {
    expect(isIssueStateChange(board, 1, ISSUE_STATE.open)).toBe(false);
    expect(isIssueStateChange(board, 3, ISSUE_STATE.closed)).toBe(false);
    expect(isIssueStateChange(board, 99, ISSUE_STATE.closed)).toBe(false);
    expect(isIssueStateChange(undefined, 1, ISSUE_STATE.closed)).toBe(false);
  });
});

describe("issueStateRejection", () => {
  it("lets the CEO close an open issue when the server can write", () => {
    expect(issueStateRejection({ issueNumber: 1, state: ISSUE_STATE.closed }, context())).toBeUndefined();
  });

  it("refuses anyone who may not hand out the work, before anything else", () => {
    expect(
      issueStateRejection({ issueNumber: 1, state: ISSUE_STATE.closed }, context({ actor: executive, writable: false })),
    ).toBe(ISSUE_STATE_REJECTION.forbidden);
  });

  it("refuses when the server has no way to write", () => {
    expect(issueStateRejection({ issueNumber: 1, state: ISSUE_STATE.closed }, context({ writable: false }))).toBe(
      ISSUE_STATE_REJECTION.unavailable,
    );
  });

  it("refuses an issue that is not in the other state on the board", () => {
    expect(issueStateRejection({ issueNumber: 3, state: ISSUE_STATE.closed }, context())).toBe(
      ISSUE_STATE_REJECTION.unknownIssue,
    );
  });
});

describe("parseIssueStateMessage", () => {
  it("takes an issue number and one of the two states", () => {
    expect(parseIssueStateMessage({ issueNumber: 4, state: "closed" })).toEqual({ issueNumber: 4, state: "closed" });
    expect(parseIssueStateMessage({ issueNumber: 4, state: "open", extra: true })).toEqual({
      issueNumber: 4,
      state: "open",
    });
  });

  it("drops anything else", () => {
    expect(parseIssueStateMessage({ issueNumber: 4, state: "merged" })).toBeUndefined();
    expect(parseIssueStateMessage({ issueNumber: -1, state: "open" })).toBeUndefined();
    expect(parseIssueStateMessage({ issueNumber: "4", state: "open" })).toBeUndefined();
    expect(parseIssueStateMessage(null)).toBeUndefined();
  });
});
