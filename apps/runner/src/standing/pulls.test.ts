/**
 * The pull request source: one REST listing, asked with the last ETag so an
 * unchanged repository costs nothing, read for what a task's filters need.
 */

import { describe, expect, it } from "vitest";

import { githubPullSource, readPull } from "./pulls.js";

const REPO = "krasovsky22/agent-office-sims";

function item(number: number, overrides: Record<string, unknown> = {}) {
  return {
    number,
    title: `Change ${number}`,
    draft: false,
    user: { login: "dana" },
    author_association: "owner",
    head: { ref: "feature", sha: `sha${number}`, repo: { full_name: REPO } },
    ...overrides,
  };
}

describe("githubPullSource", () => {
  it("asks with its token and the last ETag, and says when nothing changed", async () => {
    const asked: Array<Record<string, string>> = [];
    const answers = [
      new Response(JSON.stringify([item(12)]), { status: 200, headers: { etag: '"abc"' } }),
      new Response(null, { status: 304 }),
    ];
    const source = githubPullSource({
      repo: REPO,
      token: async () => "tok",
      fetch: async (_url, init) => {
        asked.push((init?.headers ?? {}) as Record<string, string>);
        return answers.shift() ?? new Response(null, { status: 500 });
      },
    });
    const first = await source(undefined);
    expect(first).toEqual({ kind: "listed", etag: '"abc"', pulls: [expect.objectContaining({ number: 12, association: "OWNER", ownAgent: false })] });
    expect(await source('"abc"')).toEqual({ kind: "unchanged" });
    expect(asked[0]?.["authorization"]).toBe("Bearer tok");
    expect(asked[0]?.["if-none-match"]).toBeUndefined();
    expect(asked[1]?.["if-none-match"]).toBe('"abc"');
  });

  it("asks anonymously without a token, and says so when GitHub refuses", async () => {
    const source = githubPullSource({ repo: REPO, fetch: async () => new Response("{}", { status: 404 }) });
    await expect(source(undefined)).rejects.toThrow(/HTTP 404.*asked anonymously/);
  });
});

describe("readPull", () => {
  it("knows the runner's own agents by their branch on the repository itself", () => {
    expect(readPull(item(1, { head: { ref: "sims/issue-39-slot-1", sha: "s", repo: { full_name: REPO } } }), REPO)?.ownAgent).toBe(true);
    expect(readPull(item(2, { head: { ref: "sims/issue-39-slot-1", sha: "s", repo: { full_name: "fork/agent-office-sims" } } }), REPO)?.ownAgent).toBe(false);
    expect(readPull({ number: "1" }, REPO)).toBeUndefined();
  });
});
