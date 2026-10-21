/**
 * GitHub's issue list, sorted into the project board's columns.
 *
 * Pure, and kept apart from the HTTP in `client.ts`, because the rules are the
 * part with opinions in them — what counts as being worked on, which pull
 * request closes which issue — and those deserve tests that do not need a
 * network or a fake one.
 *
 * Everything here starts as JSON from GitHub. It is a well-behaved API, but the
 * titles and bodies in it are written by anyone who can open an issue on a
 * public repository, so each item is parsed field by field, a malformed one is
 * dropped rather than trusted, and every string that reaches a client is
 * sanitized first.
 */

import {
  type BoardIssue,
  type BoardLabel,
  type BoardPullRequest,
  CHECK_STATUS,
  type CheckStatus,
  MAX_BOARD_ITEMS,
  MAX_CLOSED_ISSUES,
  MAX_ISSUE_BODY_LENGTH,
  MAX_ITEM_LABELS,
  MAX_ISSUE_TITLE_LENGTH,
  MAX_LABEL_LENGTH,
  type ProjectBoardLists,
  asRecord,
  isIssueNumber,
  sanitizeBody,
  sanitizeTitle,
  truncate,
} from "@sim/shared";

/**
 * One item from the REST issues endpoint, reduced to the fields the board reads.
 *
 * That endpoint lists pull requests as well as issues; `pullRequest` is what
 * tells them apart, and carries the two fields only a pull request has.
 */
export interface GithubIssueItem {
  readonly number: number;
  readonly title: string;
  /** The description as GitHub sent it, unsanitized; `""` when there is none. */
  readonly body: string;
  readonly labels: readonly BoardLabel[];
  readonly open: boolean;
  readonly author: string;
  readonly assignees: readonly string[];
  /** Epoch milliseconds, or `null` while the item is open. */
  readonly closedAt: number | null;
  /** Epoch milliseconds of its latest change, or `null` when GitHub did not say. */
  readonly updatedAt?: number | null;
  readonly pullRequest: { readonly draft: boolean; readonly body: string } | null;
}

/**
 * What the GraphQL API adds about an open pull request, when a token lets the
 * server ask: the issues GitHub itself has linked to it, including links made
 * by hand in the sidebar, and the rolled-up state of its head commit's checks.
 */
export interface PullRequestDetail {
  readonly closes: readonly number[];
  readonly checks: CheckStatus;
}

function loginOf(raw: unknown): string | undefined {
  const login = asRecord(raw)?.["login"];
  if (typeof login !== "string") {
    return undefined;
  }
  const clean = sanitizeTitle(login);
  return clean === "" ? undefined : clean;
}

/** GitHub's label colour: six hex digits, no `#`. */
const LABEL_COLOUR = /^[0-9a-f]{6}$/i;

/**
 * Reads one label off an issue.
 *
 * The REST API gives a label as an object, but its schema also allows a bare
 * name; both are accepted. A colour that is not six hex digits is dropped
 * rather than passed on, because a client puts it straight into a style.
 */
function labelOf(raw: unknown): BoardLabel | undefined {
  const record = asRecord(raw);
  const name = truncate(sanitizeTitle(record === undefined ? raw : record["name"]), MAX_LABEL_LENGTH).trim();
  if (name === "") {
    return undefined;
  }
  const colour = record?.["color"];
  return {
    name,
    color: typeof colour === "string" && LABEL_COLOUR.test(colour) ? `#${colour.toLowerCase()}` : "",
  };
}

function labelsOf(raw: unknown): BoardLabel[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const labels: BoardLabel[] = [];
  for (const entry of raw) {
    const label = labelOf(entry);
    if (label !== undefined && !labels.some((kept) => kept.name === label.name)) {
      labels.push(label);
    }
    if (labels.length === MAX_ITEM_LABELS) {
      break;
    }
  }
  return labels;
}

function timestampOf(raw: unknown): number | null {
  if (typeof raw !== "string") {
    return null;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Reads one REST issue-list item.
 *
 * @returns the item, or `undefined` if it is missing a field the board cannot
 * do without — a number, a title, a state.
 */
export function parseIssueItem(raw: unknown): GithubIssueItem | undefined {
  const item = asRecord(raw);
  if (item === undefined || !isIssueNumber(item["number"])) {
    return undefined;
  }
  const state = item["state"];
  if (state !== "open" && state !== "closed") {
    return undefined;
  }
  // Whole, for the board's detail pane and the manager; a card clips its own.
  const title = sanitizeTitle(item["title"], MAX_ISSUE_TITLE_LENGTH);
  if (title === "") {
    return undefined;
  }

  const assignees = Array.isArray(item["assignees"])
    ? item["assignees"].map(loginOf).filter((login): login is string => login !== undefined)
    : [];

  const isPullRequest = asRecord(item["pull_request"]) !== undefined;
  const body = typeof item["body"] === "string" ? item["body"] : "";
  return {
    number: item["number"],
    title,
    body,
    labels: labelsOf(item["labels"]),
    open: state === "open",
    author: loginOf(item["user"]) ?? "unknown",
    assignees,
    closedAt: timestampOf(item["closed_at"]),
    updatedAt: timestampOf(item["updated_at"]),
    pullRequest: isPullRequest
      ? {
          draft: item["draft"] === true,
          body,
        }
      : null,
  };
}

/** Reads a REST issue-list page, keeping the items that parse. */
export function parseIssuePage(raw: unknown): GithubIssueItem[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map(parseIssueItem).filter((item): item is GithubIssueItem => item !== undefined);
}

/**
 * The closing keywords GitHub recognises in a pull request body, followed by
 * the three ways of naming an issue: `#12`, `owner/repo#12`, or the issue's
 * full URL. GitHub accepts an optional colon after the keyword, so this does.
 */
const CLOSING_REFERENCE =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+(?:([\w.-]+\/[\w.-]+)#|https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/|#)(\d+)\b/gi;

/**
 * Issue numbers a pull request body says it closes, in this repository only.
 *
 * This is the linking that works without a token. It sees the links that
 * keywords make — this project's own convention is `Closes #N` in every PR
 * body — but not links made by hand in GitHub's sidebar; with a token the
 * GraphQL details fill those in.
 */
export function closingReferences(body: string, repository: string): number[] {
  const found = new Set<number>();
  const self = repository.toLowerCase();
  for (const match of body.matchAll(CLOSING_REFERENCE)) {
    const named = match[1] ?? match[2];
    if (named !== undefined && named.toLowerCase() !== self) {
      continue;
    }
    const number = Number.parseInt(match[3] ?? "", 10);
    if (isIssueNumber(number)) {
      found.add(number);
    }
  }
  return [...found];
}

/** An issue as a card, carrying its description only while there is work to do on it. */
function toBoardIssue(item: GithubIssueItem, pullRequests: readonly number[]): BoardIssue {
  return {
    number: item.number,
    title: item.title,
    body: item.open ? sanitizeBody(item.body, MAX_ISSUE_BODY_LENGTH) : "",
    labels: item.labels,
    assignees: item.assignees,
    pullRequests,
    closedAt: item.open ? null : item.closedAt,
    ...(typeof item.updatedAt === "number" ? { updatedAt: item.updatedAt } : {}),
  };
}

const byNumber = (a: { number: number }, b: { number: number }) => a.number - b.number;

/**
 * Sorts GitHub's items into the board's lists.
 *
 * - **Pull requests** are taken out of the issue lists first: the issues
 *   endpoint returns both, and a pull request is not an issue on this board.
 * - **In progress** is an open issue with an assignee or a linked open pull
 *   request. Either one means somebody has picked it up.
 * - **Open** is every other open issue.
 * - **Closed** is the most recently closed issues, newest first, capped at
 *   {@link MAX_CLOSED_ISSUES}.
 *
 * Issue columns read in number order, which in this repository is roughly the
 * order the work was planned in; pull requests read newest first.
 *
 * @param openItems every open issue and pull request.
 * @param closedItems recently closed issues and pull requests, in any order.
 * @param details per pull request, when the server could fetch them.
 */
export function bucketIssues(
  openItems: readonly GithubIssueItem[],
  closedItems: readonly GithubIssueItem[],
  repository: string,
  details: ReadonlyMap<number, PullRequestDetail> = new Map(),
): ProjectBoardLists {
  const openPullRequests = openItems.filter((item) => item.open && item.pullRequest !== null);

  // Issue number -> the open pull requests that close it.
  const linked = new Map<number, number[]>();
  for (const pull of openPullRequests) {
    const closes = new Set([
      ...closingReferences(pull.pullRequest?.body ?? "", repository),
      ...(details.get(pull.number)?.closes ?? []),
    ]);
    for (const issue of closes) {
      linked.set(issue, [...(linked.get(issue) ?? []), pull.number]);
    }
  }

  const open: BoardIssue[] = [];
  const inProgress: BoardIssue[] = [];
  for (const item of [...openItems].sort(byNumber)) {
    if (!item.open || item.pullRequest !== null) {
      continue;
    }
    const pulls = linked.get(item.number) ?? [];
    const issue = toBoardIssue(item, pulls);
    if (pulls.length > 0 || item.assignees.length > 0) {
      inProgress.push(issue);
    } else {
      open.push(issue);
    }
  }

  const closed = closedItems
    .filter((item) => !item.open && item.pullRequest === null)
    .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0) || b.number - a.number)
    .slice(0, MAX_CLOSED_ISSUES)
    .map((item) => toBoardIssue(item, []));

  const pullRequests: BoardPullRequest[] = [...openPullRequests]
    .sort((a, b) => b.number - a.number)
    .map((item) => ({
      number: item.number,
      title: item.title,
      labels: item.labels,
      author: item.author,
      draft: item.pullRequest?.draft ?? false,
      checks: details.get(item.number)?.checks ?? CHECK_STATUS.unknown,
    }));

  return {
    open: open.slice(0, MAX_BOARD_ITEMS),
    inProgress: inProgress.slice(0, MAX_BOARD_ITEMS),
    closed,
    pullRequests: pullRequests.slice(0, MAX_BOARD_ITEMS),
    counts: { open: open.length, inProgress: inProgress.length, pullRequests: pullRequests.length },
  };
}
