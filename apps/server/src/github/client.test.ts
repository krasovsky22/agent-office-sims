/**
 * The GitHub client against canned responses: what it asks for, what it does
 * with each kind of answer, and where the token goes. No test here touches the
 * network; `fetch` is the fake below.
 */

import { describe, expect, it } from "vitest";

import {
  type FetchLike,
  GithubRateLimitError,
  GithubRequestError,
  createGithubLoader,
  parsePullRequestDetails,
} from "./client.js";

const REPO = "krasovsky22/agent-office-sims";
const API = "https://api.github.com";

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string>) },
  });
}

/** A fake `fetch` that answers by URL and records every call. */
function fakeGithub(answer: (url: string, init: RequestInit) => Response): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return answer(url, init);
    },
  };
}

const openIssue = { number: 32, title: "Lobby board", state: "open", user: { login: "dana" }, assignees: [] };
const openPull = {
  number: 40,
  title: "Add the lobby board",
  state: "open",
  user: { login: "milo" },
  assignees: [],
  draft: false,
  body: "Closes #32",
  pull_request: {},
};
const closedIssue = {
  number: 2,
  title: "Floor plan",
  state: "closed",
  user: { login: "dana" },
  assignees: [],
  closed_at: "2026-10-01T00:00:00Z",
};

function standardAnswer(url: string): Response {
  if (url.includes("state=open")) {
    return json([openIssue, openPull], { headers: { etag: '"open-1"' } });
  }
  if (url.includes("state=closed")) {
    return json([closedIssue], { headers: { etag: '"closed-1"' } });
  }
  return json({ data: null });
}

function headerOf(call: Call | undefined, name: string): string | undefined {
  return (call?.init.headers as Record<string, string> | undefined)?.[name];
}

const signal = () => new AbortController().signal;

describe("createGithubLoader", () => {
  it("fetches open and recently closed items and buckets them", async () => {
    const github = fakeGithub(standardAnswer);
    const lists = await createGithubLoader({ repository: REPO, fetch: github.fetch })(signal());

    expect(lists.inProgress.map((item) => item.number)).toEqual([32]);
    expect(lists.closed.map((item) => item.number)).toEqual([2]);
    expect(lists.pullRequests.map((item) => item.number)).toEqual([40]);
    expect(github.calls.map((call) => call.url)).toEqual([
      `${API}/repos/${REPO}/issues?state=open&per_page=100`,
      `${API}/repos/${REPO}/issues?state=closed&sort=updated&direction=desc&per_page=50`,
    ]);
  });

  it("makes only GET requests and sends no Authorization header without a token", async () => {
    const github = fakeGithub(standardAnswer);
    await createGithubLoader({ repository: REPO, fetch: github.fetch })(signal());

    for (const call of github.calls) {
      expect(call.init.method).toBe("GET");
      expect(headerOf(call, "Authorization")).toBeUndefined();
    }
  });

  it("sends the token to the API only, and asks GraphQL for checks with it", async () => {
    const github = fakeGithub((url) =>
      url.endsWith("/graphql")
        ? json({
            data: {
              repository: {
                pullRequests: {
                  nodes: [
                    {
                      number: 40,
                      closingIssuesReferences: { nodes: [] },
                      commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
                    },
                  ],
                },
              },
            },
          })
        : standardAnswer(url),
    );
    const lists = await createGithubLoader({ repository: REPO, token: "secret-token", fetch: github.fetch })(
      signal(),
    );

    expect(lists.pullRequests[0]?.checks).toBe("failing");
    expect(github.calls).toHaveLength(3);
    for (const call of github.calls) {
      expect(call.url.startsWith(`${API}/`)).toBe(true);
      expect(headerOf(call, "Authorization")).toBe("Bearer secret-token");
    }
    const graphql = github.calls.find((call) => call.url === `${API}/graphql`);
    expect(graphql?.init.method).toBe("POST");
    expect(String(graphql?.init.body)).toContain("query BoardPullRequests");
    expect(String(graphql?.init.body)).not.toContain("mutation");
  });

  it("still builds the board when the GraphQL details fail", async () => {
    const github = fakeGithub((url) =>
      url.endsWith("/graphql") ? new Response("boom", { status: 502 }) : standardAnswer(url),
    );
    const lists = await createGithubLoader({ repository: REPO, token: "t", fetch: github.fetch })(signal());
    expect(lists.pullRequests[0]?.checks).toBe("unknown");
    expect(lists.inProgress.map((item) => item.number)).toEqual([32]);
  });

  it("revalidates with the ETag and reuses the page on a 304", async () => {
    let round = 0;
    const github = fakeGithub((url, init) => {
      if (round > 0 && headerOf({ url, init }, "If-None-Match") !== undefined) {
        return new Response(null, { status: 304 });
      }
      return standardAnswer(url);
    });
    const load = createGithubLoader({ repository: REPO, fetch: github.fetch });

    const first = await load(signal());
    round = 1;
    const second = await load(signal());

    expect(second).toEqual(first);
    expect(headerOf(github.calls[2], "If-None-Match")).toBe('"open-1"');
    expect(headerOf(github.calls[3], "If-None-Match")).toBe('"closed-1"');
  });

  it("follows pagination on the API host and nowhere else", async () => {
    const page2 = `${API}/repos/${REPO}/issues?state=open&per_page=100&page=2`;
    const github = fakeGithub((url) => {
      if (url === page2) {
        return json([{ ...openIssue, number: 33 }], {
          headers: { link: '<https://evil.example/steal>; rel="next"' },
        });
      }
      if (url.includes("state=open")) {
        return json([openIssue], { headers: { link: `<${page2}>; rel="next", <${page2}>; rel="last"` } });
      }
      return standardAnswer(url);
    });
    const lists = await createGithubLoader({ repository: REPO, token: "t", fetch: github.fetch })(signal());

    expect(lists.open.map((item) => item.number)).toEqual([32, 33]);
    expect(github.calls.some((call) => call.url.includes("evil.example"))).toBe(false);
  });

  it("reports a spent rate limit with GitHub's reset time", async () => {
    const github = fakeGithub(() =>
      json(
        { message: "API rate limit exceeded" },
        { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000000" } },
      ),
    );
    const failure = createGithubLoader({ repository: REPO, fetch: github.fetch })(signal());

    await expect(failure).rejects.toBeInstanceOf(GithubRateLimitError);
    await expect(failure).rejects.toMatchObject({ retryAt: 1_800_000_000_000 });
  });

  it("reports any other refusal as a request error that does not quote the token", async () => {
    const github = fakeGithub(() => json({ message: "Not Found" }, { status: 404 }));
    const failure = createGithubLoader({ repository: REPO, token: "secret-token", fetch: github.fetch })(signal());

    await expect(failure).rejects.toBeInstanceOf(GithubRequestError);
    await expect(failure).rejects.toThrow(/404/);
    await expect(failure).rejects.not.toThrow(/secret-token/);
  });

  it("passes a network failure through for the feed to mark stale", async () => {
    const failing: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(createGithubLoader({ repository: REPO, fetch: failing })(signal())).rejects.toThrow(
      "fetch failed",
    );
  });
});

describe("parsePullRequestDetails", () => {
  const answer = (nodes: unknown[]) => ({ data: { repository: { pullRequests: { nodes } } } });

  it("keeps only the linked issues in this repository", () => {
    const details = parsePullRequestDetails(
      answer([
        {
          number: 40,
          closingIssuesReferences: {
            nodes: [
              { number: 32, repository: { nameWithOwner: REPO } },
              { number: 9, repository: { nameWithOwner: "someone/else" } },
            ],
          },
          commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
        },
      ]),
      REPO,
    );
    expect(details.get(40)).toEqual({ closes: [32], checks: "passing" });
  });

  it.each([
    ["PENDING", "pending"],
    ["EXPECTED", "pending"],
    ["ERROR", "failing"],
    ["SOMETHING_NEW", "unknown"],
  ])("maps a %s rollup to %s", (state, expected) => {
    const details = parsePullRequestDetails(
      answer([{ number: 1, commits: { nodes: [{ commit: { statusCheckRollup: { state } } }] } }]),
      REPO,
    );
    expect(details.get(1)?.checks).toBe(expected);
  });

  it("tells a head commit with no checks apart from not knowing", () => {
    const details = parsePullRequestDetails(
      answer([{ number: 1, commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }, { number: 2 }]),
      REPO,
    );
    expect(details.get(1)?.checks).toBe("none");
    expect(details.get(2)?.checks).toBe("unknown");
  });

  it("returns nothing for an answer that is an error", () => {
    expect(parsePullRequestDetails({ errors: [{ message: "Bad credentials" }] }, REPO).size).toBe(0);
  });
});
