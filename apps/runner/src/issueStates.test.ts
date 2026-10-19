/**
 * Closing and reopening issues for the CEO: the one `gh` call each makes, how
 * its failures are told apart, and the desk that keeps what came of them for
 * the syncs.
 */

import { describe, expect, it } from "vitest";

import type { RunCommand } from "./github.js";
import { IssueStateDesk, ghIssueState } from "./issueStates.js";

const REPO = "krasovsky22/agent-office-sims";
const env = async () => ({ GH_TOKEN: "token" });

function failing(stderr: string): RunCommand {
  return async () => {
    throw Object.assign(new Error("Command failed"), { stderr });
  };
}

describe("ghIssueState", () => {
  it("closes and reopens with gh, as the runner's identity, and nothing else", async () => {
    const calls: { args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
    const run: RunCommand = async (_file, args, options) => {
      calls.push({ args, env: options.env });
      return "";
    };
    const set = ghIssueState({ repo: REPO, env, run });
    await expect(set(39, "closed")).resolves.toBe("done");
    await expect(set(39, "open")).resolves.toBe("done");
    expect(calls.map((call) => call.args)).toEqual([
      ["issue", "close", "39", "--repo", REPO],
      ["issue", "reopen", "39", "--repo", REPO],
    ]);
    expect(calls[0]?.env["GH_TOKEN"]).toBe("token");
  });

  it("calls GitHub saying no a refusal, and anything else a failure", async () => {
    await expect(
      ghIssueState({ repo: REPO, env, run: failing("GraphQL: Resource not accessible by integration (closeIssue)") })(39, "closed"),
    ).resolves.toBe("refused");
    await expect(ghIssueState({ repo: REPO, env, run: failing("HTTP 403: Forbidden") })(39, "closed")).resolves.toBe("refused");
    await expect(ghIssueState({ repo: REPO, env, run: failing("error connecting to api.github.com") })(39, "open")).resolves.toBe(
      "failed",
    );
  });
});

describe("IssueStateDesk", () => {
  it("keeps each outcome until a sync carrying it is answered", async () => {
    const lines: string[] = [];
    const desk = new IssueStateDesk({ set: async () => "refused", log: (line) => lines.push(line) });
    await desk.handle({ id: "command-1", kind: "issue-state", issueNumber: 39, state: "closed", requestedBy: "Dana" });
    expect(desk.pending()).toEqual([{ commandId: "command-1", outcome: "refused" }]);
    expect(lines).toEqual(["closing #39 for Dana: refused"]);
    desk.delivered(new Set(["command-1"]));
    expect(desk.pending()).toEqual([]);
  });
});
