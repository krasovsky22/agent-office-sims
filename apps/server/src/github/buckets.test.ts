/**
 * The bucket rules are the claims the issue makes about the board — what is
 * open, what is in progress, what counts as linked — so each case below is one
 * of those claims, stated against GitHub-shaped input.
 */

import { describe, expect, it } from "vitest";

import { MAX_CLOSED_ISSUES, MAX_ITEM_LABELS } from "@sim/shared";

import {
  type GithubIssueItem,
  type PullRequestDetail,
  bucketIssues,
  closingReferences,
  parseIssueItem,
  parseIssuePage,
} from "./buckets.js";

const REPO = "krasovsky22/agent-office-sims";

function issue(number: number, extra: Partial<GithubIssueItem> = {}): GithubIssueItem {
  return {
    number,
    title: `Issue ${number}`,
    labels: [],
    open: true,
    author: "dana",
    assignees: [],
    closedAt: null,
    pullRequest: null,
    ...extra,
  };
}

function pull(number: number, body: string, extra: Partial<GithubIssueItem> = {}): GithubIssueItem {
  return issue(number, { title: `PR ${number}`, pullRequest: { draft: false, body }, ...extra });
}

function closed(number: number, closedAt: number): GithubIssueItem {
  return issue(number, { open: false, closedAt });
}

const numbers = (list: readonly { number: number }[]) => list.map((item) => item.number);

describe("bucketIssues", () => {
  it("keeps pull requests out of the issue columns", () => {
    const lists = bucketIssues([issue(1), pull(2, "")], [closed(3, 10), { ...pull(4, ""), open: false }], REPO);

    expect(numbers(lists.open)).toEqual([1]);
    expect(numbers(lists.inProgress)).toEqual([]);
    expect(numbers(lists.closed)).toEqual([3]);
    expect(numbers(lists.pullRequests)).toEqual([2]);
  });

  it("puts an open issue with no assignee and no linked pull request in Open", () => {
    expect(numbers(bucketIssues([issue(7)], [], REPO).open)).toEqual([7]);
  });

  it("moves an issue with an assignee to In progress", () => {
    const lists = bucketIssues([issue(7, { assignees: ["milo"] })], [], REPO);
    expect(numbers(lists.open)).toEqual([]);
    expect(lists.inProgress).toEqual([
      { number: 7, title: "Issue 7", labels: [], assignees: ["milo"], pullRequests: [], closedAt: null },
    ]);
  });

  it("moves an issue that an open pull request closes to In progress, naming the pull request", () => {
    const lists = bucketIssues([issue(32), issue(33), pull(40, "Adds the board.\n\nCloses #32")], [], REPO);
    expect(numbers(lists.open)).toEqual([33]);
    expect(lists.inProgress[0]?.number).toBe(32);
    expect(lists.inProgress[0]?.pullRequests).toEqual([40]);
  });

  it("counts a draft pull request as work in progress", () => {
    const lists = bucketIssues([issue(5), pull(6, "fixes #5", { pullRequest: { draft: true, body: "fixes #5" } })], [], REPO);
    expect(numbers(lists.inProgress)).toEqual([5]);
    expect(lists.pullRequests[0]?.draft).toBe(true);
  });

  it("carries each issue's and pull request's labels onto its card", () => {
    const wave = { name: "wave-1", color: "#0e8a16" };
    const client = { name: "client", color: "#1d76db" };
    const lists = bucketIssues(
      [issue(7, { labels: [wave] }), pull(8, "", { labels: [client, wave] })],
      [{ ...closed(3, 10), labels: [client] }],
      REPO,
    );
    expect(lists.open[0]?.labels).toEqual([wave]);
    expect(lists.pullRequests[0]?.labels).toEqual([client, wave]);
    expect(lists.closed[0]?.labels).toEqual([client]);
  });

  it("lets go of an issue once its pull request is closed or merged", () => {
    // A closed pull request is not in the open list GitHub returns, so it
    // links nothing; the issue falls back to Open on the next poll.
    const lists = bucketIssues([issue(32)], [{ ...pull(40, "Closes #32"), open: false, closedAt: 5 }], REPO);
    expect(numbers(lists.open)).toEqual([32]);
    expect(lists.pullRequests).toEqual([]);
  });

  it("links through the GraphQL details when the body names nothing", () => {
    const details = new Map<number, PullRequestDetail>([[40, { closes: [32], checks: "passing" }]]);
    const lists = bucketIssues([issue(32), pull(40, "no keywords here")], [], REPO, details);
    expect(numbers(lists.inProgress)).toEqual([32]);
    expect(lists.pullRequests[0]).toEqual({
      number: 40,
      title: "PR 40",
      labels: [],
      author: "dana",
      draft: false,
      checks: "passing",
    });
  });

  it("reports checks as unknown without details", () => {
    expect(bucketIssues([pull(40, "")], [], REPO).pullRequests[0]?.checks).toBe("unknown");
  });

  it("keeps the most recently closed issues, newest first, capped", () => {
    const many = Array.from({ length: MAX_CLOSED_ISSUES + 5 }, (_unused, index) => closed(index + 1, index * 1000));
    const lists = bucketIssues([], many, REPO);
    expect(lists.closed).toHaveLength(MAX_CLOSED_ISSUES);
    expect(lists.closed[0]?.number).toBe(MAX_CLOSED_ISSUES + 5);
    expect(lists.closed[0]?.closedAt).toBe((MAX_CLOSED_ISSUES + 4) * 1000);
  });

  it("counts every open issue even when the lists are capped", () => {
    const lots = Array.from({ length: 60 }, (_unused, index) => issue(index + 1));
    const lists = bucketIssues(lots, [], REPO);
    expect(lists.open.length).toBeLessThan(60);
    expect(lists.counts.open).toBe(60);
  });

  it("reads issue columns in number order and pull requests newest first", () => {
    const lists = bucketIssues([issue(9), pull(11, ""), issue(3), pull(12, "")], [], REPO);
    expect(numbers(lists.open)).toEqual([3, 9]);
    expect(numbers(lists.pullRequests)).toEqual([12, 11]);
  });
});

describe("closingReferences", () => {
  it.each([
    ["Closes #32", [32]],
    ["fixes #1 and resolves #2", [1, 2]],
    ["Fixed: #4", [4]],
    [`closes ${REPO}#5`, [5]],
    [`Resolves https://github.com/${REPO}/issues/6`, [6]],
    ["CLOSES #7", [7]],
  ])("finds the issues in %j", (body, expected) => {
    expect(closingReferences(body, REPO)).toEqual(expected);
  });

  it.each([
    ["a mention without a keyword", "see #32"],
    ["another repository's issue", "closes someone/else#32"],
    ["a keyword inside a longer word", "encloses #32"],
  ])("ignores %s", (_label, body) => {
    expect(closingReferences(body, REPO)).toEqual([]);
  });

  it("names each issue once however often the body repeats it", () => {
    expect(closingReferences("Closes #3. Really, closes #3.", REPO)).toEqual([3]);
  });
});

describe("parseIssueItem", () => {
  const raw = {
    number: 32,
    title: "Lobby project board:\nlive GitHub issues",
    state: "open",
    labels: [{ name: "wave-1", color: "0E8A16" }, { name: "client", color: "1d76db" }],
    user: { login: "krasovsky22" },
    assignees: [{ login: "milo" }, { nope: true }],
    closed_at: null,
    body: "ignored for an issue",
  };

  it("reads an issue, sanitizing its title onto one line", () => {
    expect(parseIssueItem(raw)).toEqual({
      number: 32,
      title: "Lobby project board: live GitHub issues",
      labels: [
        { name: "wave-1", color: "#0e8a16" },
        { name: "client", color: "#1d76db" },
      ],
      open: true,
      author: "krasovsky22",
      assignees: ["milo"],
      closedAt: null,
      pullRequest: null,
    });
  });

  it("reads a label given as a bare name, with no colour", () => {
    expect(parseIssueItem({ ...raw, labels: ["wave-2"] })?.labels).toEqual([{ name: "wave-2", color: "" }]);
  });

  it("drops a colour that is not six hex digits, since a client styles with it", () => {
    const labels = [{ name: "bug", color: "red;background:url(x)" }];
    expect(parseIssueItem({ ...raw, labels })?.labels).toEqual([{ name: "bug", color: "" }]);
  });

  it("drops blank and repeated labels, sanitizes names, and keeps a card's worth", () => {
    const many = Array.from({ length: MAX_ITEM_LABELS + 4 }, (_, index) => ({ name: `tag-${index}`, color: "ffffff" }));
    const labels = [{ name: " \n " }, { name: "wave\n1" }, { name: "wave 1" }, null, ...many];
    const parsed = parseIssueItem({ ...raw, labels })?.labels ?? [];
    expect(parsed.map((label) => label.name).slice(0, 3)).toEqual(["wave 1", "tag-0", "tag-1"]);
    expect(parsed).toHaveLength(MAX_ITEM_LABELS);
  });

  it("reads an item with no labels field as unlabelled", () => {
    expect(parseIssueItem({ ...raw, labels: undefined })?.labels).toEqual([]);
  });

  it("recognises a pull request by its pull_request field", () => {
    const parsed = parseIssueItem({ ...raw, draft: true, pull_request: { url: "x" }, body: "Closes #1" });
    expect(parsed?.pullRequest).toEqual({ draft: true, body: "Closes #1" });
  });

  it("reads a closed issue's closing time", () => {
    expect(parseIssueItem({ ...raw, state: "closed", closed_at: "2026-10-01T12:00:00Z" })?.closedAt).toBe(
      Date.parse("2026-10-01T12:00:00Z"),
    );
  });

  it.each([
    ["no number", { ...raw, number: undefined }],
    ["an unknown state", { ...raw, state: "merged" }],
    ["a blank title", { ...raw, title: "  \n " }],
    ["not an object", "issue"],
  ])("drops an item with %s", (_label, item) => {
    expect(parseIssueItem(item)).toBeUndefined();
  });

  it("keeps the items of a page that parse", () => {
    expect(parseIssuePage([raw, null, { ...raw, number: 33 }]).map((item) => item.number)).toEqual([32, 33]);
    expect(parseIssuePage({ message: "Not Found" })).toEqual([]);
  });
});
