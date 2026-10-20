/**
 * The cards this player dropped on Closed or Open, shown there at once.
 *
 * Each waits for the server's answer; a refusal puts it back and says why.
 * One GitHub took stays until a snapshot shows it there, or one from a poll
 * begun after the change shows GitHub's own state, whatever this tab assumed.
 */

import type { IssueState, IssueStateResultEvent, ProjectBoardSnapshot } from "@sim/shared";

import { issueStateRejectionText } from "./boardAccess.js";
import { type IssueMove, hasIssueMoveLanded } from "./projectBoard.js";

/**
 * How long a card dropped on Closed or Open waits for the server's answer
 * before it goes back; past the server's own wait on GitHub, which answers first.
 */
export const ISSUE_MOVE_ANSWER_MS = 30_000;

/**
 * How long a card GitHub moved stays where it was dropped without a snapshot
 * showing it there, for a feed that has gone stale and stopped publishing.
 */
export const ISSUE_MOVE_HOLD_MS = 120_000;

/** What the moves need of the game loop. */
export interface PendingIssueMovesHost {
  /** Hands the board the moves to show, after any is made or dropped. */
  readonly publish: (moves: readonly IssueMove[]) => void;
  /** Says on the board why a card went back. */
  readonly notice: (text: string) => void;
  /** Asks the server to close or reopen the issue on GitHub. */
  readonly send: (issueNumber: number, state: IssueState) => void;
}

interface PendingIssueMove {
  readonly issueNumber: number;
  readonly state: IssueState;
  /** Once GitHub made the change, the fresh snapshots since; the move now waits only for a snapshot. */
  freshSince: number | undefined;
  timer: ReturnType<typeof setTimeout>;
}

export class PendingIssueMoves {
  private moves: PendingIssueMove[] = [];

  public constructor(private readonly host: PendingIssueMovesHost) {}

  /** A card dropped on Closed or Open: shown there, and asked of the server; one already on its way is left be. */
  public move(issueNumber: number, state: IssueState): void {
    if (this.moves.some((move) => move.issueNumber === issueNumber)) {
      return;
    }
    const move: PendingIssueMove = {
      issueNumber,
      state,
      freshSince: undefined,
      timer: setTimeout(() => {
        this.drop(move);
        this.host.notice(`No answer about #${issueNumber} from the server; the board shows it as GitHub last did.`);
      }, ISSUE_MOVE_ANSWER_MS),
    };
    this.moves = [...this.moves, move];
    this.publish();
    this.host.send(issueNumber, state);
  }

  /** The server's answer to a move: refused, it goes back; taken, it waits for a snapshot to show it. */
  public answered(event: IssueStateResultEvent): void {
    const move = this.moves.find(
      (candidate) => candidate.issueNumber === event.issueNumber && candidate.state === event.state && candidate.freshSince === undefined,
    );
    if (move === undefined) {
      return;
    }
    if (event.rejection !== undefined) {
      this.drop(move);
      this.host.notice(issueStateRejectionText(event.rejection, event.issueNumber, event.state));
      return;
    }
    clearTimeout(move.timer);
    move.freshSince = 0;
    move.timer = setTimeout(() => this.drop(move), ISSUE_MOVE_HOLD_MS);
  }

  /** A new snapshot of the board: each move GitHub took that it has caught up with is done. */
  public snapshot(snapshot: ProjectBoardSnapshot): void {
    for (const move of this.moves) {
      if (move.freshSince === undefined) {
        continue;
      }
      if (hasIssueMoveLanded(snapshot, move, move.freshSince)) {
        this.drop(move);
      } else if (!snapshot.stale) {
        move.freshSince += 1;
      }
    }
  }

  private drop(move: PendingIssueMove): void {
    clearTimeout(move.timer);
    this.moves = this.moves.filter((candidate) => candidate !== move);
    this.publish();
  }

  private publish(): void {
    this.host.publish(this.moves.map(({ issueNumber, state }) => ({ issueNumber, state })));
  }
}
