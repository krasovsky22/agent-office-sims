/**
 * Where a `pr-review` standing task learns of new pull requests: GitHub's
 * open pull requests for the repository, polled by the runner itself.
 *
 * One REST call, `GET /repos/{repo}/pulls?state=open`, with the listing's
 * last ETag as `If-None-Match`: an unchanged repository answers `304`, which
 * an authorised call does not count against the rate limit. The REST listing
 * is the one that says each author's association with the repository, which
 * the task's author filter needs; `gh pr list` does not.
 *
 * A real agent's runner asks as the agents' GitHub identity. The mock's asks
 * anonymously, which only a public repository answers, and is held to one
 * look every five minutes by its scheduler, inside GitHub's anonymous limit.
 */

import { asRecord } from "@sim/shared";

import { BRANCH_PREFIX } from "../worktrees.js";

/** One open pull request, as much of it as a task's filters and its review need. */
export interface OpenPull {
  readonly number: number;
  readonly title: string;
  readonly draft: boolean;
  /** Its author's login. */
  readonly author: string;
  /** `OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, `NONE` and the rest, as GitHub says it. */
  readonly association: string;
  /** Opened by one of this runner's own agents: from a `sims/` branch on the repository itself. */
  readonly ownAgent: boolean;
  readonly headSha: string;
}

export type PullListing =
  | { readonly kind: "unchanged" }
  | { readonly kind: "listed"; readonly etag: string | undefined; readonly pulls: readonly OpenPull[] };

/** Lists the open pull requests, or says they are as they were at `etag`. Rejects with why when GitHub could not be asked. */
export type PullSource = (etag: string | undefined) => Promise<PullListing>;

export interface GithubPullSourceOptions {
  /** `owner/name`. */
  readonly repo: string;
  /** The agents' token, kept fresh; `undefined` to ask anonymously. */
  readonly token?: () => Promise<string | undefined>;
  /** Injected so a test can answer for GitHub. */
  readonly fetch?: typeof fetch;
}

const API_URL = "https://api.github.com";

/** One page is plenty: a repository with more open pull requests than this has its newest reviewed. */
const PER_PAGE = 100;

const REQUEST_TIMEOUT_MS = 30_000;

function str(raw: unknown): string {
  return typeof raw === "string" ? raw : "";
}

/** One pull request off GitHub's listing, or `undefined` for an item that is not one. */
export function readPull(raw: unknown, repo: string): OpenPull | undefined {
  const pull = asRecord(raw);
  const number = pull?.["number"];
  if (pull === undefined || typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) {
    return undefined;
  }
  const head = asRecord(pull["head"]);
  const headRepo = asRecord(head?.["repo"]);
  const ownAgent = str(head?.["ref"]).startsWith(BRANCH_PREFIX) && str(headRepo?.["full_name"]).toLowerCase() === repo.toLowerCase();
  return {
    number,
    title: str(pull["title"]),
    draft: pull["draft"] === true,
    author: str(asRecord(pull["user"])?.["login"]),
    association: str(pull["author_association"]).toUpperCase(),
    ownAgent,
    headSha: str(head?.["sha"]),
  };
}

export function githubPullSource(options: GithubPullSourceOptions): PullSource {
  const send = options.fetch ?? fetch;
  const url = `${API_URL}/repos/${options.repo}/pulls?state=open&per_page=${PER_PAGE}&sort=created&direction=desc`;
  return async (etag) => {
    const token = await options.token?.();
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "user-agent": "agent-office-sims-runner",
      "x-github-api-version": "2022-11-28",
    };
    if (token !== undefined) {
      headers["authorization"] = `Bearer ${token}`;
    }
    if (etag !== undefined) {
      headers["if-none-match"] = etag;
    }
    const response = await send(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: "error" });
    if (response.status === 304) {
      return { kind: "unchanged" };
    }
    if (!response.ok) {
      const anonymous = token === undefined ? " (asked anonymously, which only a public repository answers)" : "";
      throw new Error(`GitHub answered HTTP ${response.status} for ${options.repo}'s pull requests${anonymous}`);
    }
    const body: unknown = await response.json();
    if (!Array.isArray(body)) {
      throw new Error("GitHub's pull request listing was not a list");
    }
    const pulls = body.flatMap((item) => {
      const pull = readPull(item, options.repo);
      return pull === undefined ? [] : [pull];
    });
    return { kind: "listed", etag: response.headers.get("etag") ?? undefined, pulls };
  };
}
