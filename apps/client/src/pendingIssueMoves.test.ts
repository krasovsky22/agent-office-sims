/** A card dropped on Closed or Open waits for the server, then for the board's snapshot to catch up. */

import { EMPTY_BOARD_LISTS, ISSUE_STATE, ISSUE_STATE_REJECTION, type ProjectBoardSnapshot } from "@sim/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ISSUE_MOVE_ANSWER_MS, ISSUE_MOVE_HOLD_MS, PendingIssueMoves } from "./pendingIssueMoves.js";
import type { IssueMove } from "./projectBoard.js";

const BOARD: ProjectBoardSnapshot = { repository: "o/r", updatedAt: 1, stale: false, ...EMPTY_BOARD_LISTS };

describe("PendingIssueMoves", () => {
  let shown: readonly IssueMove[];
  let notices: string[];
  let sent: [number, string][];
  let moves: PendingIssueMoves;

  beforeEach(() => {
    vi.useFakeTimers();
    shown = [];
    notices = [];
    sent = [];
    moves = new PendingIssueMoves({
      publish: (next) => {
        shown = next;
      },
      notice: (text) => notices.push(text),
      send: (issueNumber, state) => sent.push([issueNumber, state]),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a dropped card at once and asks the server, once however often it is dropped", () => {
    moves.move(7, ISSUE_STATE.closed);
    moves.move(7, ISSUE_STATE.open);
    expect(shown).toEqual([{ issueNumber: 7, state: ISSUE_STATE.closed }]);
    expect(sent).toEqual([[7, ISSUE_STATE.closed]]);
  });

  it("puts the card back and says why when the server refuses", () => {
    moves.move(7, ISSUE_STATE.closed);
    moves.answered({ issueNumber: 7, state: ISSUE_STATE.closed, rejection: ISSUE_STATE_REJECTION.forbidden });
    expect(shown).toEqual([]);
    expect(notices).toHaveLength(1);
  });

  it("puts the card back when the server never answers", () => {
    moves.move(7, ISSUE_STATE.closed);
    vi.advanceTimersByTime(ISSUE_MOVE_ANSWER_MS);
    expect(shown).toEqual([]);
    expect(notices).toEqual(["No answer about #7 from the server; the board shows it as GitHub last did."]);
  });

  it("keeps a move GitHub took until the second fresh snapshot, which is GitHub's word", () => {
    moves.move(7, ISSUE_STATE.closed);
    moves.answered({ issueNumber: 7, state: ISSUE_STATE.closed });
    moves.snapshot({ ...BOARD, stale: true });
    moves.snapshot(BOARD);
    expect(shown).toHaveLength(1);
    moves.snapshot(BOARD);
    expect(shown).toEqual([]);
    expect(notices).toEqual([]);
  });

  it("lets a move GitHub took go once a stale feed has held it long enough", () => {
    moves.move(7, ISSUE_STATE.closed);
    moves.answered({ issueNumber: 7, state: ISSUE_STATE.closed });
    vi.advanceTimersByTime(ISSUE_MOVE_ANSWER_MS);
    expect(shown).toHaveLength(1);
    vi.advanceTimersByTime(ISSUE_MOVE_HOLD_MS - ISSUE_MOVE_ANSWER_MS);
    expect(shown).toEqual([]);
  });
});
