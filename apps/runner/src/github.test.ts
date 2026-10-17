/**
 * The runner's questions to GitHub, with `gh` and `git` answered by a fake:
 * the label check fails closed, and a task's pull request is the open one,
 * one opened for a branch pushed without, or none.
 */

import { describe, expect, it } from "vitest";

import { type RunCommand, createTaskGithub, ownPr } from "./github.js";

const REPO = "krasovsky22/agent-office-sims";
const ENV = { GH_CONFIG_DIR: "/runner/gh" };

interface Call {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
  readonly env: NodeJS.ProcessEnv;
}

/** Answers each command by its first words; anything unanswered fails as `gh` would. */
function fake(answers: Record<string, string | Error>): { run: RunCommand; calls: Call[] } {
  const calls: Call[] = [];
  const run: RunCommand = async (file, args, options) => {
    calls.push({ file, args, cwd: options.cwd, env: options.env });
    const key = Object.keys(answers).find((prefix) => `${file} ${args.join(" ")}`.startsWith(prefix));
    const answer = key === undefined ? new Error(`no answer for ${file} ${args.join(" ")}`) : answers[key];
    if (answer instanceof Error) {
      throw Object.assign(answer, { stderr: `${answer.message}\n` });
    }
    return answer ?? "";
  };
  return { run, calls };
}

function github(answers: Record<string, string | Error>) {
  const { run, calls } = fake(answers);
  return { github: createTaskGithub({ repo: REPO, label: "agent-ready", env: async () => ENV, run }), calls };
}

const TASK = {
  issueNumber: 39,
  title: "Night shift",
  workdir: "/runner/worktrees/issue-39-slot-1",
  requestedBy: "Dana",
  agentName: "Claude 1",
};

describe("ownPr", () => {
  it("reads the pull request `gh pr create` printed, the last one", () => {
    expect(
      ownPr("git push -u origin HEAD && gh pr create --fill", `remote: ...\nhttps://github.com/${REPO}/pull/95\n`, REPO),
    ).toEqual({ number: 95, url: `https://github.com/${REPO}/pull/95` });
  });

  it("ignores a command that only names it, and a pull request on another repository", () => {
    expect(ownPr("grep 'gh pr create' README.md", `https://github.com/${REPO}/pull/95`, REPO)).toBeUndefined();
    expect(ownPr("gh pr create --fill", "https://github.com/someone/else/pull/3", REPO)).toBeUndefined();
    expect(ownPr(undefined, `https://github.com/${REPO}/pull/95`, REPO)).toBeUndefined();
  });

  it("matches the repository whatever its case", () => {
    expect(ownPr("gh pr create --fill", "https://github.com/Krasovsky22/Agent-Office-Sims/pull/7", REPO)?.number).toBe(7);
  });
});

describe("refusal", () => {
  it("lets an open issue with the label be worked, asking as the runner's identity", async () => {
    const { github: gh, calls } = github({
      "gh issue view 39": JSON.stringify({ state: "OPEN", labels: [{ name: "client" }, { name: "Agent-Ready" }] }),
    });
    expect(await gh.refusal(39)).toBeUndefined();
    expect(calls[0]?.args).toEqual(["issue", "view", "39", "--repo", REPO, "--json", "state,labels"]);
    expect(calls[0]?.env).toBe(ENV);
  });

  it("refuses an issue without the label, a closed one, and one it could not check", async () => {
    expect(await github({ "gh issue view": JSON.stringify({ state: "OPEN", labels: [{ name: "bug" }] }) }).github.refusal(39)).toBe(
      "#39 is not labelled agent-ready on GitHub, so no agent may work it",
    );
    expect(await github({ "gh issue view": JSON.stringify({ state: "CLOSED", labels: [{ name: "agent-ready" }] }) }).github.refusal(39)).toBe(
      "#39 is not open on GitHub",
    );
    expect(await github({ "gh issue view": new Error("HTTP 401: Bad credentials") }).github.refusal(39)).toBe(
      "Could not check #39 on GitHub: HTTP 401: Bad credentials",
    );
  });
});

describe("pullRequest", () => {
  it("finds the open pull request for the task's branch", async () => {
    const { github: gh, calls } = github({
      "git rev-parse --abbrev-ref HEAD": "sims/issue-39-slot-1",
      "gh pr list": JSON.stringify([{ number: 95, title: "Night shift", url: `https://github.com/${REPO}/pull/95` }]),
    });
    expect(await gh.pullRequest(TASK)).toEqual({ number: 95, title: "Night shift", url: `https://github.com/${REPO}/pull/95` });
    expect(calls.map((call) => call.cwd)).toEqual([TASK.workdir, TASK.workdir]);
    expect(calls[1]?.args).toContain("sims/issue-39-slot-1");
  });

  it("opens one, closing the issue and saying who asked, for a branch pushed without", async () => {
    const { github: gh, calls } = github({
      "git rev-parse --abbrev-ref HEAD": "sims/issue-39-slot-1",
      "gh pr list": "[]",
      "git ls-remote": "abc123\trefs/heads/sims/issue-39-slot-1",
      "git symbolic-ref": "origin/main",
      "gh pr create": `Creating pull request\nhttps://github.com/${REPO}/pull/96`,
    });
    expect(await gh.pullRequest(TASK)).toEqual({ number: 96, title: "Night shift", url: `https://github.com/${REPO}/pull/96` });
    const create = calls.find((call) => call.args[1] === "create")?.args ?? [];
    expect(create.slice(0, 10)).toEqual(["pr", "create", "--repo", REPO, "--head", "sims/issue-39-slot-1", "--base", "main", "--title", "Night shift"]);
    const body = create[create.indexOf("--body") + 1] ?? "";
    expect(body.startsWith("Closes #39\n")).toBe(true);
    expect(body).toContain("Claude 1 worked #39 for Dana");
  });

  it("has none for a branch that was never pushed, or a detached worktree", async () => {
    expect(
      await github({ "git rev-parse --abbrev-ref HEAD": "sims/issue-39-slot-1", "gh pr list": "[]", "git ls-remote": "" }).github.pullRequest(TASK),
    ).toBeUndefined();
    expect(await github({ "git rev-parse --abbrev-ref HEAD": "HEAD" }).github.pullRequest(TASK)).toBeUndefined();
  });

  it("rejects when GitHub cannot be asked", async () => {
    await expect(
      github({ "git rev-parse --abbrev-ref HEAD": "sims/issue-39-slot-1", "gh pr list": new Error("HTTP 502") }).github.pullRequest(TASK),
    ).rejects.toThrow(/HTTP 502/);
  });
});

describe("pullRequestTitle", () => {
  it("reads the title of a pull request as the runner's identity", async () => {
    const { github: gh, calls } = github({ "gh pr view 96": JSON.stringify({ title: "Night shift" }) });
    expect(await gh.pullRequestTitle(96)).toBe("Night shift");
    expect(calls[0]?.args).toEqual(["pr", "view", "96", "--repo", REPO, "--json", "title"]);
    expect(calls[0]?.env).toEqual(ENV);
  });

  it("is empty when GitHub cannot say", async () => {
    expect(await github({ "gh pr view": new Error("HTTP 502") }).github.pullRequestTitle(96)).toBe("");
    expect(await github({ "gh pr view": "<html>" }).github.pullRequestTitle(96)).toBe("");
  });
});
