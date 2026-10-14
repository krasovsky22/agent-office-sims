/**
 * What the project board says, decided once for both of the places it is said.
 *
 * The wall board in the scene and the close-up panel in the HUD show the same
 * snapshot, one painted onto a canvas and one as React text. Both read their
 * columns, row wording and status line from here, so the two cannot disagree
 * about which column an issue is in or whether the board is stale.
 *
 * Every string comes from the server's snapshot, which has already sanitized
 * it; both renderers take text rather than markup.
 */

import {
  type BoardIssue,
  type BoardLabel,
  type BoardPullRequest,
  type CheckStatus,
  type ProjectBoardSnapshot,
} from "@sim/shared";

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
  /** The card's GitHub labels, drawn as chips and filtered by. */
  readonly labels: readonly BoardLabel[];
  /** Everything a search looks through, lower case: number, title, labels, detail. */
  readonly searchText: string;
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

function searchTextOf(label: string, title: string, labels: readonly BoardLabel[], detail: string): string {
  return [label, title, ...labels.map((tag) => tag.name), detail].join(" ").toLowerCase();
}

function issueRow(issue: BoardIssue, formatDate: TimeFormatter): BoardRow {
  const parts = [
    ...issue.assignees.map((login) => `@${login}`),
    ...issue.pullRequests.map((number) => `PR #${number}`),
  ];
  if (issue.closedAt !== null) {
    parts.push(`closed ${formatDate(issue.closedAt)}`);
  }
  const label = `#${issue.number}`;
  const detail = parts.join(" · ");
  return {
    key: `issue-${issue.number}`,
    label,
    title: issue.title,
    detail,
    tone: "plain",
    labels: issue.labels,
    searchText: searchTextOf(label, issue.title, issue.labels, detail),
  };
}

function pullRequestRow(pull: BoardPullRequest): BoardRow {
  const checks = CHECK_TEXT[pull.checks];
  const parts = [`@${pull.author}`, ...(pull.draft ? ["draft"] : []), ...(checks.text === "" ? [] : [checks.text])];
  const label = `#${pull.number}`;
  const detail = parts.join(" · ");
  return {
    key: `pull-${pull.number}`,
    label,
    title: pull.title,
    detail,
    tone: checks.tone,
    labels: pull.labels,
    searchText: searchTextOf(label, pull.title, pull.labels, detail),
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

/** What the close-up is narrowed to: free text, and labels a card must all carry. */
export interface BoardFilter {
  readonly query: string;
  readonly labels: ReadonlySet<string>;
}

export const NO_BOARD_FILTER: BoardFilter = { query: "", labels: new Set() };

/** Whether a filter narrows anything, so a view can say it is showing matches. */
export function isFiltering(filter: BoardFilter): boolean {
  return filter.query.trim() !== "" || filter.labels.size > 0;
}

/**
 * The columns with only the rows a filter lets through.
 *
 * Every word of the query has to appear somewhere in a row, and the row has to
 * carry every selected label: the same "and" GitHub's own label filter means,
 * so `wave-1` plus `client` narrows rather than widens. A column keeps its
 * GitHub total, since that is still how many there are; what matched is the
 * length of its rows.
 */
export function filterBoardColumns(columns: readonly BoardColumn[], filter: BoardFilter): BoardColumn[] {
  if (!isFiltering(filter)) {
    return [...columns];
  }
  const terms = filter.query.toLowerCase().split(/\s+/).filter((term) => term !== "");
  const matches = (row: BoardRow) =>
    terms.every((term) => row.searchText.includes(term)) &&
    [...filter.labels].every((name) => row.labels.some((label) => label.name === name));
  return columns.map((column) => ({ ...column, rows: column.rows.filter(matches) }));
}

/**
 * Every label on the board, once each, for the close-up's filter chips.
 *
 * Sorted by name with numbers compared as numbers, so `wave-2` comes before
 * `wave-10`. A label's colour is the first one seen; GitHub gives a label one
 * colour per repository, so they agree anyway. A selected label is listed even
 * after a poll takes its last card away, so it can still be seen and turned off
 * rather than silently matching nothing.
 */
export function boardLabels(snapshot: ProjectBoardSnapshot, selected: ReadonlySet<string> = new Set()): BoardLabel[] {
  const byName = new Map<string, BoardLabel>();
  for (const item of [...snapshot.open, ...snapshot.inProgress, ...snapshot.closed, ...snapshot.pullRequests]) {
    for (const label of item.labels) {
      if (!byName.has(label.name)) {
        byName.set(label.name, label);
      }
    }
  }
  for (const name of selected) {
    if (!byName.has(name)) {
      byName.set(name, { name, color: "" });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** Chip colour for a label GitHub gave no usable colour. */
const NEUTRAL_LABEL = "#5b606b";

/**
 * A label chip's fill and the text colour that reads on it.
 *
 * GitHub label colours run from near-white to near-black, so the text flips
 * between dark and light on the fill's relative luminance rather than being
 * one colour that some labels swallow.
 */
export function labelColours(label: BoardLabel): { fill: string; text: string } {
  const fill = /^#[0-9a-f]{6}$/.test(label.color) ? label.color : NEUTRAL_LABEL;
  const channel = (offset: number) => {
    const value = Number.parseInt(fill.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  // 0.179 is where black and white text have equal contrast against the fill.
  return { fill, text: luminance > 0.179 ? "#000000" : "#ffffff" };
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
