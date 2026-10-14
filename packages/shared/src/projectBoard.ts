/**
 * The lobby board's contract: what the server tells every client about this
 * repository's own development, and where a player has to stand to read it.
 *
 * The board is not the in-game ticket board. That one is the simulated
 * company's work, held in replicated state and changed by commands; this one is
 * a read-only window onto real GitHub issues and pull requests, fetched by the
 * server and handed to clients whole. Nothing a client does changes it, and
 * nothing here can write to GitHub.
 *
 * It travels as a server broadcast rather than as schema. A snapshot is
 * replaced wholesale on every poll, so there is nothing for per-field change
 * tracking to save, and a plain object keeps the GitHub vocabulary out of the
 * schema the simulation depends on. The server sends the current snapshot to a
 * client as it joins and broadcasts every replacement, so every client in the
 * room holds the same one.
 */

import type { Vec2, WallBoardSpec } from "./layout.js";

/** How a pull request's checks stand, as far as the server could cheaply tell. */
export const CHECK_STATUS = {
  passing: "passing",
  failing: "failing",
  pending: "pending",
  /** The head commit has no checks at all. */
  none: "none",
  /** The server did not ask, or could not find out. */
  unknown: "unknown",
} as const;

export type CheckStatus = (typeof CHECK_STATUS)[keyof typeof CHECK_STATUS];

/** One issue, reduced to what a board card shows. */
export interface BoardIssue {
  readonly number: number;
  /** Sanitized and length-capped by the server. Safe to render as text. */
  readonly title: string;
  readonly assignees: readonly string[];
  /** Open pull requests that say they close this issue. */
  readonly pullRequests: readonly number[];
  /** Epoch milliseconds, for a closed issue; `null` for an open one. */
  readonly closedAt: number | null;
}

/** One open pull request, reduced to what a board card shows. */
export interface BoardPullRequest {
  readonly number: number;
  readonly title: string;
  readonly author: string;
  readonly draft: boolean;
  readonly checks: CheckStatus;
}

/**
 * The issue columns and the pull request list, as the server bucketed them.
 *
 * Each list is capped at {@link MAX_BOARD_ITEMS}; `counts` carries the
 * uncapped totals, so a board can say how many it is not showing.
 */
export interface ProjectBoardLists {
  /** Open issues nobody is working on: no assignee, no linked open pull request. */
  readonly open: readonly BoardIssue[];
  /** Open issues with an assignee or a linked open pull request. */
  readonly inProgress: readonly BoardIssue[];
  /** The most recently closed issues, newest first, capped at {@link MAX_CLOSED_ISSUES}. */
  readonly closed: readonly BoardIssue[];
  readonly pullRequests: readonly BoardPullRequest[];
  readonly counts: {
    readonly open: number;
    readonly inProgress: number;
    readonly pullRequests: number;
  };
}

/** What the server broadcasts as {@link SERVER_MESSAGE.projectBoard}. */
export interface ProjectBoardSnapshot extends ProjectBoardLists {
  /** `owner/name` of the repository the lists describe. */
  readonly repository: string;
  /**
   * Epoch milliseconds of the last successful fetch, or `null` if there has
   * not been one yet.
   */
  readonly updatedAt: number | null;
  /**
   * Whether the latest fetch failed. The lists are then the last ones that
   * succeeded — or empty, if none has — and a board says so rather than
   * presenting old news as current.
   */
  readonly stale: boolean;
}

/** Longest list a snapshot carries, so one busy repository cannot flood the socket. */
export const MAX_BOARD_ITEMS = 40;

/** Recently closed issues kept on the board. Enough to show momentum, not a history. */
export const MAX_CLOSED_ISSUES = 10;

/** Lists with nothing in them, for a snapshot that has never had a successful fetch. */
export const EMPTY_BOARD_LISTS: ProjectBoardLists = {
  open: [],
  inProgress: [],
  closed: [],
  pullRequests: [],
  counts: { open: 0, inProgress: 0, pullRequests: 0 },
};

/**
 * How far in front of a board a player can stand and get its close-up view.
 *
 * Shorter than the lobby is deep, so walking up to the board is a decision and
 * standing in the middle of the room is not; the wall board itself is sized to
 * be read from there.
 */
export const BOARD_CLOSE_UP_RANGE = 2.6;

/** Slack either side of a board's width that still counts as standing in front of it. */
const BOARD_CLOSE_UP_SIDE_MARGIN = 0.5;

/**
 * Whether a point stands in front of a board and close enough to read it up
 * close.
 *
 * A range check against the board's face rather than a distance to its centre,
 * so standing behind the wall it hangs on does not count. This is the simple
 * check the interaction prompt work can replace; it reads nothing but the
 * floor plan, so client and server would agree on it if both ever asked.
 */
export function isWithinBoardRange(
  board: WallBoardSpec,
  point: Vec2,
  range: number = BOARD_CLOSE_UP_RANGE,
): boolean {
  const dx = point.x - board.x;
  const dz = point.z - board.z;
  // Yaw 0 faces -Z, so the face looks along (-sin, -cos) and its width runs
  // along the perpendicular (cos, -sin).
  const ahead = -dx * Math.sin(board.yaw) - dz * Math.cos(board.yaw);
  const across = dx * Math.cos(board.yaw) - dz * Math.sin(board.yaw);
  return ahead > 0 && ahead <= range && Math.abs(across) <= board.width / 2 + BOARD_CLOSE_UP_SIDE_MARGIN;
}
