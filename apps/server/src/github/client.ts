/**
 * The HTTP half of the project board's GitHub feed: one call that fetches a
 * repository's issues and open pull requests and hands back the board's lists.
 *
 * It reads and never writes. Every request is a GET against the REST API,
 * except one read-only GraphQL query made only when a token is configured,
 * because GitHub does not answer GraphQL anonymously.
 *
 * Two requests per poll do the work: open items, which include the open pull
 * requests with their bodies and draft flags, and recently closed items. Each
 * REST page is sent with the `ETag` it was last answered with, so an unchanged
 * repository costs a `304` rather than a page.
 *
 * `fetch` is injected, so the tests drive this with canned responses and no
 * network. The token is only ever put in an `Authorization` header to the
 * GitHub API host, and never into an error message or a URL.
 */

import { CHECK_STATUS, type CheckStatus, type ProjectBoardLists, asRecord } from "@sim/shared";

import {
  type GithubIssueItem,
  type PullRequestDetail,
  bucketIssues,
  parseIssuePage,
} from "./buckets.js";

/** The subset of `fetch` the client calls, so a test can stand in for it. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Loads one fresh set of board lists. Rejects when it cannot. */
export type BoardLoader = (signal: AbortSignal) => Promise<ProjectBoardLists>;

export interface GithubClientOptions {
  /** `owner/name`. */
  readonly repository: string;
  readonly token?: string | undefined;
  readonly fetch?: FetchLike;
}

/** GitHub refused because the rate limit is spent. */
export class GithubRateLimitError extends Error {
  /** Epoch milliseconds at which GitHub says to try again, if it said. */
  public readonly retryAt: number | undefined;

  public constructor(retryAt: number | undefined) {
    super("GitHub rate limit reached");
    this.name = "GithubRateLimitError";
    this.retryAt = retryAt;
  }
}

/** GitHub answered, but not with something the board can use. */
export class GithubRequestError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GithubRequestError";
  }
}

const API_URL = "https://api.github.com";

/** Open items fetched per page; the REST API's maximum. */
const OPEN_PAGE_SIZE = 100;

/**
 * Pages of open items followed before stopping.
 *
 * The board shows a few dozen cards at most, so a repository with more than
 * this many open items still gets an honest board — just not an exhaustive
 * one — and one poll cannot turn into an unbounded crawl.
 */
const MAX_OPEN_PAGES = 3;

/**
 * Recently closed items fetched. Pull requests share the list, so this is
 * comfortably more than the board keeps.
 */
const CLOSED_PAGE_SIZE = 50;

/** Open pull requests asked about over GraphQL, and linked issues per pull request. */
const GRAPHQL_PULL_REQUESTS = 50;
const GRAPHQL_CLOSING_ISSUES = 10;

const PULL_REQUEST_DETAILS_QUERY = `
query BoardPullRequests($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: ${GRAPHQL_PULL_REQUESTS}, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes {
        number
        closingIssuesReferences(first: ${GRAPHQL_CLOSING_ISSUES}) {
          nodes { number repository { nameWithOwner } }
        }
        commits(last: 1) {
          nodes { commit { statusCheckRollup { state } } }
        }
      }
    }
  }
}`;

/** A REST page as last answered, kept for the `304` that says it has not changed. */
interface CachedPage {
  readonly etag: string;
  readonly items: GithubIssueItem[];
  readonly next: string | undefined;
}

/** The `rel="next"` URL out of a `Link` header, if there is one. */
function nextPageUrl(link: string | null): string | undefined {
  if (link === null) {
    return undefined;
  }
  for (const part of link.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }
  return undefined;
}

/**
 * Whether a response is GitHub saying the rate limit is spent, and when to
 * come back if so.
 *
 * GitHub signals both limits with a 403 or a 429: the primary one with
 * `x-ratelimit-remaining: 0` and a reset time, the secondary one with
 * `retry-after`. A 403 with neither is a permissions problem, not a limit.
 */
function rateLimitOf(response: Response): GithubRateLimitError | undefined {
  if (response.status !== 403 && response.status !== 429) {
    return undefined;
  }
  const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
  if (Number.isFinite(retryAfter)) {
    return new GithubRateLimitError(Date.now() + retryAfter * 1000);
  }
  if (response.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number.parseInt(response.headers.get("x-ratelimit-reset") ?? "", 10);
    return new GithubRateLimitError(Number.isFinite(reset) ? reset * 1000 : undefined);
  }
  return response.status === 429 ? new GithubRateLimitError(undefined) : undefined;
}

function checksOf(state: unknown): CheckStatus {
  switch (state) {
    case "SUCCESS":
      return CHECK_STATUS.passing;
    case "FAILURE":
    case "ERROR":
      return CHECK_STATUS.failing;
    case "PENDING":
    case "EXPECTED":
      return CHECK_STATUS.pending;
    default:
      return CHECK_STATUS.unknown;
  }
}

function nodesOf(raw: unknown): unknown[] {
  const nodes = asRecord(raw)?.["nodes"];
  return Array.isArray(nodes) ? nodes : [];
}

/** Reads the GraphQL answer into per-pull-request details, skipping what does not parse. */
export function parsePullRequestDetails(
  raw: unknown,
  repository: string,
): Map<number, PullRequestDetail> {
  const details = new Map<number, PullRequestDetail>();
  const pulls = asRecord(asRecord(asRecord(raw)?.["data"])?.["repository"])?.["pullRequests"];
  const self = repository.toLowerCase();

  for (const node of nodesOf(pulls)) {
    const pull = asRecord(node);
    const number = pull?.["number"];
    if (pull === undefined || typeof number !== "number") {
      continue;
    }
    const closes = nodesOf(pull["closingIssuesReferences"]).flatMap((reference) => {
      const issue = asRecord(reference);
      const owner = asRecord(issue?.["repository"])?.["nameWithOwner"];
      const issueNumber = issue?.["number"];
      return typeof issueNumber === "number" &&
        typeof owner === "string" &&
        owner.toLowerCase() === self
        ? [issueNumber]
        : [];
    });
    const commit = asRecord(asRecord(nodesOf(pull["commits"])[0])?.["commit"]);
    const rollup = commit?.["statusCheckRollup"];
    details.set(number, {
      closes,
      // A head commit with no checks has a null rollup, which is a real answer
      // and not the same as not knowing.
      checks: commit !== undefined && rollup === null ? CHECK_STATUS.none : checksOf(asRecord(rollup)?.["state"]),
    });
  }
  return details;
}

/**
 * Builds the loader the feed polls.
 *
 * The returned function keeps its ETag cache between calls, so it is made once
 * per process and called on every poll.
 */
export function createGithubLoader(options: GithubClientOptions): BoardLoader {
  const fetchImpl: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const { repository, token } = options;
  const cache = new Map<string, CachedPage>();

  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "agent-office-sims",
    ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
    ...extra,
  });

  const getPage = async (url: string, signal: AbortSignal): Promise<CachedPage> => {
    const cached = cache.get(url);
    const response = await fetchImpl(url, {
      method: "GET",
      headers: headers(cached === undefined ? {} : { "If-None-Match": cached.etag }),
      signal,
    });
    if (response.status === 304 && cached !== undefined) {
      return cached;
    }
    const limited = rateLimitOf(response);
    if (limited !== undefined) {
      throw limited;
    }
    if (!response.ok) {
      throw new GithubRequestError(`GitHub answered ${response.status} for ${new URL(url).pathname}`);
    }

    const next = nextPageUrl(response.headers.get("link"));
    const page: CachedPage = {
      etag: response.headers.get("etag") ?? "",
      items: parseIssuePage(await response.json()),
      // Only ever follow a link back to GitHub's API, so a
      // token is never sent anywhere a response header points it.
      next: next !== undefined && next.startsWith(`${API_URL}/`) ? next : undefined,
    };
    if (page.etag !== "") {
      cache.set(url, page);
    }
    return page;
  };

  const getOpenItems = async (signal: AbortSignal): Promise<GithubIssueItem[]> => {
    const items: GithubIssueItem[] = [];
    let url: string | undefined =
      `${API_URL}/repos/${repository}/issues?state=open&per_page=${OPEN_PAGE_SIZE}`;
    for (let page = 0; url !== undefined && page < MAX_OPEN_PAGES; page += 1) {
      const result: CachedPage = await getPage(url, signal);
      items.push(...result.items);
      url = result.next;
    }
    return items;
  };

  /**
   * Linked issues and check states, or nothing.
   *
   * Never fatal: the board is still right about every issue without them, so a
   * failure here leaves checks unknown and links to the closing keywords rather
   * than marking the whole snapshot stale.
   */
  const getDetails = async (signal: AbortSignal): Promise<Map<number, PullRequestDetail>> => {
    if (token === undefined) {
      return new Map();
    }
    const [owner, name] = repository.split("/");
    try {
      const response = await fetchImpl(`${API_URL}/graphql`, {
        method: "POST",
        headers: headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ query: PULL_REQUEST_DETAILS_QUERY, variables: { owner, name } }),
        signal,
      });
      return response.ok ? parsePullRequestDetails(await response.json(), repository) : new Map();
    } catch {
      return new Map();
    }
  };

  return async (signal) => {
    const [openItems, closedPage, details] = await Promise.all([
      getOpenItems(signal),
      getPage(
        `${API_URL}/repos/${repository}/issues?state=closed&sort=updated&direction=desc&per_page=${CLOSED_PAGE_SIZE}`,
        signal,
      ),
      getDetails(signal),
    ]);
    return bucketIssues(openItems, closedPage.items, repository, details);
  };
}
