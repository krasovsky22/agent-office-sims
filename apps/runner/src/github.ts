// Adapted from agent-office (MIT, Copyright (c) 2026 AgentSystemLabs): src/server/workers/pr.ts. See THIRD_PARTY_NOTICES.md.
/**
 * What the runner itself asks of GitHub about a task: whether its issue may
 * be worked, and which pull request its work is in.
 *
 * The server already refuses an issue with the restriction label, and the
 * runner asks GitHub again before its agent starts, so an agent spends nothing
 * on an issue on the word of a server alone.
 *
 * A task's agent is asked to push its branch and open the pull request
 * itself, and the runner reads the pull request off the command that opened
 * it ({@link ownPr}, from the agent's hooks). When a turn ends without one it
 * looks for itself: an open pull request for the task's branch, or a branch
 * the agent pushed without opening one, which the runner opens for it, saying
 * it closes the issue. Never a merge: that is a person's, on GitHub.
 *
 * Every call goes through `gh` and `git` with the environment the agents'
 * GitHub identity gives: the runner's GitHub App (`./githubApp.ts`) or a
 * person's token (`./githubPersonal.ts`).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { MAX_TITLE_LENGTH, type RunnerPullRequest } from "@sim/shared";

import { BRANCH_PREFIX } from "./worktrees.js";

const execFileP = promisify(execFile);

const GH_TIMEOUT_MS = 60_000;

/** `gh pr create` being run, alone or in a longer line: not one that only names it (a grep for it, a quoted string). */
const CREATES_PR = /(?:^|[\s;&|(])gh\s+pr\s+create\b/;
const PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;

/**
 * The pull request an agent opened itself on `repo`, read off a shell command
 * it ran and what that printed: `gh pr create` prints the new pull request's
 * URL, or the one its branch already had. The last one printed is it.
 */
export function ownPr(command: unknown, output: string, repo: string): { number: number; url: string } | undefined {
  if (typeof command !== "string" || !CREATES_PR.test(command)) {
    return undefined;
  }
  const last = [...output.matchAll(PR_URL)].pop();
  if (last === undefined || last[1]?.toLowerCase() !== repo.toLowerCase()) {
    return undefined;
  }
  return { number: Number(last[2]), url: last[0] };
}

/** Runs a command and resolves to what it printed. Injected so a test can answer for `gh` and `git`. */
export type RunCommand = (
  file: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env: NodeJS.ProcessEnv },
) => Promise<string>;

export const runCommand: RunCommand = async (file, args, options) => {
  const { stdout } = await execFileP(file, [...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env,
    encoding: "utf8",
    timeout: GH_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
};

/** What a hand-in needs to know about its task. */
export interface HandInTask {
  readonly issueNumber: number;
  /** The issue's title, which a pull request the runner opens is given. */
  readonly title: string;
  /** The task's worktree. */
  readonly workdir: string;
  /** Who asked for the work, and who did it, for the pull request's attribution line. */
  readonly requestedBy: string;
  readonly agentName: string;
}

/** The runner's questions to GitHub about its tasks. */
export interface TaskGithub {
  /** Why the issue may not be worked, or `undefined` when it may. Never rejects. */
  refusal(issueNumber: number): Promise<string | undefined>;
  /**
   * The open pull request for the task's branch, opening one when the agent
   * pushed the branch without; `undefined` when there is none to be had.
   * Rejects with why when GitHub could not be asked.
   */
  pullRequest(task: HandInTask): Promise<RunnerPullRequest | undefined>;
  /** The title of pull request `number`, for one read off the command that opened it; `""` when GitHub could not say. Never rejects. */
  pullRequestTitle(number: number): Promise<string>;
  /**
   * Throws a cancelled task's work away on GitHub: closes the open pull
   * request for its `branch` and deletes the branch from origin, run in `cwd`,
   * a checkout of the repository. Only a task's own `sims/` branch is touched.
   * Says what went wrong, if anything; never rejects.
   */
  discard(branch: string, cwd: string): Promise<string | undefined>;
}

export interface TaskGithubOptions {
  /** `owner/name`. */
  readonly repo: string;
  /** The label that keeps agents off an issue, `REAL_AGENT_RESTRICT_LABEL`. */
  readonly label: string;
  /** The environment for a `gh` or `git` call, with the runner's GitHub identity in it. */
  readonly env: () => Promise<NodeJS.ProcessEnv>;
  readonly run?: RunCommand;
}

/** The last line a command printed to stderr, which says what went wrong. */
function failure(error: unknown): string {
  const { stderr, message } = error as { stderr?: string; message?: string };
  return (
    String(stderr || message || error)
      .trim()
      .split("\n")
      .filter(Boolean)
      .pop() ?? "it failed"
  );
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function createTaskGithub(options: TaskGithubOptions): TaskGithub {
  const run = options.run ?? runCommand;
  const { repo, label } = options;

  const gh = async (args: readonly string[], cwd?: string): Promise<string> =>
    run("gh", args, { env: await options.env(), ...(cwd === undefined ? {} : { cwd }) });
  const git = async (args: readonly string[], cwd: string): Promise<string> =>
    run("git", args, { env: await options.env(), cwd });

  return {
    async refusal(issueNumber) {
      let issue: { state?: unknown; labels?: unknown };
      try {
        issue = JSON.parse(await gh(["issue", "view", String(issueNumber), "--repo", repo, "--json", "state,labels"])) as typeof issue;
      } catch (error) {
        return `Could not check #${issueNumber} on GitHub: ${failure(error)}`;
      }
      if (issue.state !== "OPEN") {
        return `#${issueNumber} is not open on GitHub`;
      }
      const labels = Array.isArray(issue.labels) ? (issue.labels as { name?: unknown }[]) : [];
      const unwanted = label.toLowerCase();
      if (labels.some((candidate) => typeof candidate.name === "string" && candidate.name.toLowerCase() === unwanted)) {
        return `#${issueNumber} is labelled ${label} on GitHub, so no agent may work it`;
      }
      return undefined;
    },

    async pullRequest(task) {
      const { workdir } = task;
      const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], workdir);
      if (branch === "" || branch === "HEAD") {
        return undefined;
      }
      const listed = JSON.parse(
        await gh(["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--limit", "1", "--json", "number,title,url"], workdir),
      ) as { number?: unknown; title?: unknown; url?: unknown }[];
      const open = listed[0];
      if (open !== undefined && typeof open.number === "number" && typeof open.url === "string") {
        return { number: open.number, title: typeof open.title === "string" ? open.title : "", url: open.url };
      }
      // Pushed without a pull request: the branch is on origin, so open one for it.
      const pushed = await git(["ls-remote", "--heads", "origin", `refs/heads/${branch}`], workdir);
      if (pushed === "") {
        return undefined;
      }
      const base = (await git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], workdir)).replace(/^origin\//, "");
      const title = cut(task.title, Math.min(MAX_TITLE_LENGTH, 72));
      const body = [
        `Closes #${task.issueNumber}`,
        "",
        `_Opened from the office by its agent runner: ${task.agentName} worked #${task.issueNumber} for ${task.requestedBy}._`,
      ].join("\n");
      const out = await gh(
        ["pr", "create", "--repo", repo, "--head", branch, ...(base === "" ? [] : ["--base", base]), "--title", title, "--body", body],
        workdir,
      );
      const url = out.split("\n").pop() ?? "";
      const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
      if (!Number.isSafeInteger(number) || number <= 0) {
        throw new Error(`gh did not say which pull request it opened (${cut(out, 120)})`);
      }
      return { number, title, url };
    },

    async discard(branch, workdir) {
      try {
        if (!branch.startsWith(BRANCH_PREFIX)) {
          return undefined;
        }
        const listed = JSON.parse(
          await gh(["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "number"], workdir),
        ) as { number?: unknown }[];
        for (const { number } of listed) {
          if (typeof number === "number") {
            await gh(["pr", "close", String(number), "--repo", repo, "--comment", "Closed from the office: the CEO cancelled this task."], workdir);
          }
        }
        if ((await git(["ls-remote", "--heads", "origin", `refs/heads/${branch}`], workdir)) !== "") {
          await git(["push", "origin", "--delete", branch], workdir);
        }
        return undefined;
      } catch (error) {
        return failure(error);
      }
    },

    async pullRequestTitle(number) {
      try {
        const { title } = JSON.parse(await gh(["pr", "view", String(number), "--repo", repo, "--json", "title"])) as { title?: unknown };
        return typeof title === "string" ? title : "";
      } catch {
        return "";
      }
    },
  };
}

/** A task's GitHub for an agent that never touches GitHub, the `mock`: every issue may be worked, and no branch has a pull request. */
export const NO_GITHUB: TaskGithub = {
  refusal: () => Promise.resolve(undefined),
  pullRequest: () => Promise.resolve(undefined),
  pullRequestTitle: () => Promise.resolve(""),
  discard: () => Promise.resolve(undefined),
};
