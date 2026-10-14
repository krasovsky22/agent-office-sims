/**
 * What the lobby board says, decided once for both of the places it is said.
 *
 * The wall board in the scene and the close-up panel in the HUD show the same
 * snapshot, one painted onto a canvas and one as React text. Both read their
 * columns, row wording and status line from here, so the two cannot disagree
 * about which column an issue is in or whether the board is stale.
 *
 * Every string comes from the server's snapshot, which has already sanitized
 * it; both renderers take text rather than markup.
 */

import { type BoardIssue, type BoardPullRequest, type CheckStatus, type ProjectBoardSnapshot } from "@sim/shared";

export type BoardColumnKey = "open" | "inProgress" | "closed" | "pullRequests";

/** How a row's detail line should be coloured. */
export type BoardTone = "plain" | "good" | "bad" | "pending";

export interface BoardRow {
  readonly key: string;
  /** `#32`, so a row is findable on GitHub. */
  readonly label: string;
  readonly title: string;
  /** Who and what, in a few words. Empty when there is nothing to add. */
  readonly detail: string;
  readonly tone: BoardTone;
}

export interface BoardColumn {
  readonly key: BoardColumnKey;
  readonly title: string;
  /** Items in the column on GitHub, which may be more than `rows` carries. */
  readonly total: number;
  readonly rows: readonly BoardRow[];
}

/** The line above the columns: where the data is from and how fresh it is. */
export interface BoardStatus {
  readonly text: string;
  readonly stale: boolean;
}

/** Formats an epoch-millisecond time; injected so tests do not depend on a locale. */
export type TimeFormatter = (epochMs: number) => string;

const CHECK_TEXT: Record<CheckStatus, { text: string; tone: BoardTone }> = {
  passing: { text: "checks passing", tone: "good" },
  failing: { text: "checks failing", tone: "bad" },
  pending: { text: "checks running", tone: "pending" },
  none: { text: "no checks", tone: "plain" },
  unknown: { text: "", tone: "plain" },
};

function issueRow(issue: BoardIssue, formatDate: TimeFormatter): BoardRow {
  const parts = [
    ...issue.assignees.map((login) => `@${login}`),
    ...issue.pullRequests.map((number) => `PR #${number}`),
  ];
  if (issue.closedAt !== null) {
    parts.push(`closed ${formatDate(issue.closedAt)}`);
  }
  return {
    key: `issue-${issue.number}`,
    label: `#${issue.number}`,
    title: issue.title,
    detail: parts.join(" · "),
    tone: "plain",
  };
}

function pullRequestRow(pull: BoardPullRequest): BoardRow {
  const checks = CHECK_TEXT[pull.checks];
  const parts = [`@${pull.author}`, ...(pull.draft ? ["draft"] : []), ...(checks.text === "" ? [] : [checks.text])];
  return {
    key: `pull-${pull.number}`,
    label: `#${pull.number}`,
    title: pull.title,
    detail: parts.join(" · "),
    tone: checks.tone,
  };
}

/** The four columns, left to right, in the order work moves through them. */
export function boardColumns(snapshot: ProjectBoardSnapshot, formatDate: TimeFormatter): BoardColumn[] {
  return [
    {
      key: "open",
      title: "Open",
      total: snapshot.counts.open,
      rows: snapshot.open.map((issue) => issueRow(issue, formatDate)),
    },
    {
      key: "inProgress",
      title: "In progress",
      total: snapshot.counts.inProgress,
      rows: snapshot.inProgress.map((issue) => issueRow(issue, formatDate)),
    },
    {
      key: "closed",
      title: "Closed",
      total: snapshot.closed.length,
      rows: snapshot.closed.map((issue) => issueRow(issue, formatDate)),
    },
    {
      key: "pullRequests",
      title: "Open PRs",
      total: snapshot.counts.pullRequests,
      rows: snapshot.pullRequests.map(pullRequestRow),
    },
  ];
}

/**
 * Says how fresh the board is.
 *
 * A stale board keeps showing its lists — they were right when fetched — but
 * says plainly that they may not be now, rather than passing old news off as
 * current.
 */
export function boardStatus(snapshot: ProjectBoardSnapshot | undefined, formatTime: TimeFormatter): BoardStatus {
  if (snapshot === undefined) {
    return { text: "Waiting for GitHub…", stale: false };
  }
  if (snapshot.updatedAt === null) {
    return { text: "Stale — no data yet", stale: true };
  }
  const updated = formatTime(snapshot.updatedAt);
  return snapshot.stale
    ? { text: `Stale — last updated ${updated}`, stale: true }
    : { text: `Updated ${updated}`, stale: false };
}

/** Clock time, which is what "last updated" needs on a board looked at today. */
export const formatClockTime: TimeFormatter = (epochMs) =>
  new Date(epochMs).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** Day and month, for when an issue was closed. */
export const formatShortDate: TimeFormatter = (epochMs) =>
  new Date(epochMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });
