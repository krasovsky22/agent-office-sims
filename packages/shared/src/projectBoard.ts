/**
 * The project board's contract: what the server tells every client about this
 * repository's own development.
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

/**
 * One GitHub label, as a board chip shows it: the `wave-1`, `client` or `bug`
 * a card is tagged with, which is also what the close-up filters by.
 */
export interface BoardLabel {
  /** Sanitized and length-capped by the server. Safe to render as text. */
  readonly name: string;
  /** `#rrggbb`, lower case, or `""` when GitHub gave no usable colour. */
  readonly color: string;
}

/** One issue, reduced to what a board card shows. */
export interface BoardIssue {
  readonly number: number;
  /** Sanitized and length-capped by the server. Safe to render as text. */
  readonly title: string;
  /** In the order GitHub lists them, capped at {@link MAX_ITEM_LABELS}. */
  readonly labels: readonly BoardLabel[];
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
  /** In the order GitHub lists them, capped at {@link MAX_ITEM_LABELS}. */
  readonly labels: readonly BoardLabel[];
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

/** Labels kept per card; GitHub allows many more than a card has room to show. */
export const MAX_ITEM_LABELS = 8;

/** Longest label name a snapshot carries, which is also GitHub's own limit. */
export const MAX_LABEL_LENGTH = 50;

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
