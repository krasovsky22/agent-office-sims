/**
 * The GitHub and git side of the pull request steward, all of it the
 * runner's own: reading a pull request's merge state and checks, merging it,
 * and merging its base into its branch so an agent can resolve the conflicts,
 * then committing and pushing what the agent left.
 *
 * The merge is never an agent's: the runner reads the checks itself, asks
 * `stewardStep` in `@sim/shared` (whose `mergeGate` wants every required
 * check green), and merges with `--match-head-commit`, so a push after its
 * look can never be merged on the strength of the checks it read. An agent
 * resolving conflicts gets no GitHub identity and no shell; the runner
 * commits only the files that were in conflict, refuses any that still carry
 * conflict markers, and pushes without force, so a branch that moved since is
 * never overwritten. Git's hooks are off for all of it: they would be the
 * pull request's code running on the runner's machine.
 */

import { readFileSync } from "node:fs";
import { dirname } from "node:path";

import { type PullCheck, type PullState, asRecord } from "@sim/shared";

import type { RunCommand } from "../github.js";
import { headPath } from "./review.js";

/** Most checks read off a pull request's head; past it, `mergeGate` merges nothing. */
const MAX_CHECKS = 100;

/** GitHub's merge state, its checks and whether the base branch requires each, in one call. */
const PULL_STATE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state isDraft mergeable mergeStateStatus headRefOid headRefName baseRefName isCrossRepository
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: ${MAX_CHECKS}) {
        pageInfo { hasNextPage }
        nodes {
          __typename
          ... on CheckRun { name status conclusion isRequired(pullRequestNumber: $number) }
          ... on StatusContext { context state isRequired(pullRequestNumber: $number) }
        }
      } } } } }
    }
  }
}`;

/** A check run's or a status's result, as the merge gate counts it. */
function checkState(node: Record<string, unknown>): PullCheck["state"] {
  if (node["__typename"] === "StatusContext") {
    const state = node["state"];
    return state === "SUCCESS" ? "pass" : state === "PENDING" || state === "EXPECTED" ? "pending" : "fail";
  }
  if (node["status"] !== "COMPLETED") {
    return "pending";
  }
  const conclusion = node["conclusion"];
  if (conclusion === "SUCCESS") {
    return "pass";
  }
  return conclusion === "SKIPPED" || conclusion === "NEUTRAL" ? "skipped" : "fail";
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A pull request's state off GitHub's GraphQL answer; rejects with why for one that is not there. */
export function readPullState(raw: unknown, number: number): PullState {
  const pull = asRecord(asRecord(asRecord(asRecord(raw)?.["data"])?.["repository"])?.["pullRequest"]);
  if (pull === undefined) {
    throw new Error(`GitHub has no pull request #${number}`);
  }
  const commits = asRecord(pull["commits"])?.["nodes"];
  const last = Array.isArray(commits) ? asRecord(asRecord(commits[commits.length - 1])?.["commit"]) : undefined;
  const contexts = asRecord(asRecord(last?.["statusCheckRollup"])?.["contexts"]);
  const nodes = Array.isArray(contexts?.["nodes"]) ? (contexts["nodes"] as unknown[]) : [];
  const checks = nodes.flatMap((item): PullCheck[] => {
    const node = asRecord(item);
    if (node === undefined) {
      return [];
    }
    const name = node["__typename"] === "StatusContext" ? text(node["context"]) : text(node["name"]);
    return [{ name: name || "unnamed check", state: checkState(node), required: node["isRequired"] === true }];
  });
  return {
    open: pull["state"] === "OPEN",
    draft: pull["isDraft"] === true,
    headSha: text(pull["headRefOid"]).toLowerCase(),
    headRef: text(pull["headRefName"]),
    baseRef: text(pull["baseRefName"]),
    crossRepository: pull["isCrossRepository"] !== false,
    mergeable: text(pull["mergeable"]),
    mergeState: text(pull["mergeStateStatus"]),
    checks,
    checksTruncated: asRecord(contexts?.["pageInfo"])?.["hasNextPage"] === true,
  };
}

/** A pull request's checks as one line each, for the run's log: `✓ ci (required)`. */
export function describeChecks(checks: readonly PullCheck[]): string[] {
  const mark = { pass: "✓", fail: "✗", pending: "…", skipped: "-" } as const;
  return checks.map((check) => `${mark[check.state]} ${check.name}${check.required ? " (required)" : ""}`);
}

/** A branch name git and GitHub would both take, nothing an option or a path trick could hide in. */
const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

/** Lines that only a conflict leaves: git's markers, at the start of a line. */
const CONFLICT_MARKER = /^(?:<{7}|>{7})(?: |$)|^={7}$/m;

export interface StewardGithub {
  /** Rejects with why when GitHub could not be asked. */
  inspect(number: number): Promise<PullState>;
  /** Merges it, squashed, if its head is still `headSha`; rejects with GitHub's why otherwise. */
  merge(number: number, headSha: string): Promise<void>;
  /**
   * Checks the pull request's head out in the scratch worktree `dir` and
   * merges its base in, uncommitted.
   *
   * @returns the files left in conflict, none when it merged cleanly, and
   * whether there was nothing to merge at all.
   */
  startMerge(dir: string, number: number, state: PullState): Promise<{ readonly conflicts: readonly string[]; readonly upToDate: boolean }>;
  /**
   * Commits the merge with `files` as they are now, refusing any that still
   * carry a conflict marker, and pushes it to the pull request's branch.
   *
   * @returns the new head commit.
   */
  finishMerge(dir: string, state: PullState, files: readonly string[], message: string): Promise<string>;
}

export interface StewardGithubOptions {
  /** `owner/name`. */
  readonly repo: string;
  /** The environment for the runner's `gh` and `git`, with the agents' GitHub identity in it. */
  readonly env: () => Promise<NodeJS.ProcessEnv>;
  readonly run: RunCommand;
}

export function createStewardGithub(options: StewardGithubOptions): StewardGithub {
  const { repo, run } = options;
  const [owner, name] = repo.split("/");
  const gh = async (args: readonly string[]): Promise<string> => run("gh", args, { env: await options.env() });
  /** Git in a scratch worktree, hooks off, and never looking above the folder the scratch worktrees are in. */
  const git = async (dir: string, args: readonly string[]): Promise<string> =>
    run("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: dir,
      env: { ...(await options.env()), GIT_TERMINAL_PROMPT: "0", GIT_CEILING_DIRECTORIES: dirname(dir) },
    });
  const unmerged = async (dir: string): Promise<string[]> =>
    (await git(dir, ["diff", "--name-only", "--diff-filter=U", "-z"])).split("\u0000").filter((path) => path !== "");

  return {
    async inspect(number) {
      const out = await gh(["api", "graphql", "-f", `query=${PULL_STATE_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${number}`]);
      return readPullState(JSON.parse(out) as unknown, number);
    },

    async merge(number, headSha) {
      await gh(["pr", "merge", String(number), "--repo", repo, "--squash", "--match-head-commit", headSha]);
    },

    async startMerge(dir, number, state) {
      if (state.crossRepository || !BRANCH.test(state.headRef) || !BRANCH.test(state.baseRef)) {
        throw new Error(`PR #${number}'s branches are not ones the runner pushes to`);
      }
      await git(dir, ["fetch", "--no-tags", "origin", `refs/heads/${state.baseRef}`]);
      const base = await git(dir, ["rev-parse", "FETCH_HEAD"]);
      await git(dir, ["fetch", "--no-tags", "origin", `refs/pull/${number}/head`]);
      const head = (await git(dir, ["rev-parse", "FETCH_HEAD"])).toLowerCase();
      if (head !== state.headSha) {
        throw new Error(`PR #${number} moved to ${head.slice(0, 7)} while it was being looked at`);
      }
      await git(dir, ["checkout", "--quiet", "--detach", head]);
      try {
        const out = await git(dir, ["merge", "--no-ff", "--no-commit", base]);
        return { conflicts: [], upToDate: /already up to date/i.test(out) };
      } catch (error) {
        const conflicts = await unmerged(dir);
        if (conflicts.length === 0) {
          throw error;
        }
        return { conflicts, upToDate: false };
      }
    },

    async finishMerge(dir, state, files, message) {
      for (const file of files) {
        const path = headPath(dir, file);
        if (path === undefined) {
          throw new Error(`${file} is not a path in the checkout`);
        }
        let content = "";
        try {
          content = readFileSync(path, "utf8");
        } catch {
          // Deleted on purpose: one side removed it, and the agent kept that.
          continue;
        }
        if (CONFLICT_MARKER.test(content)) {
          throw new Error(`${file} still has conflict markers`);
        }
      }
      if (files.length > 0) {
        await git(dir, ["add", "--all", "--", ...files]);
      }
      const left = await unmerged(dir);
      if (left.length > 0) {
        throw new Error(`still in conflict: ${left.join(", ")}`);
      }
      const email = await git(dir, ["config", "user.email"]).catch(() => "");
      const who = email === "" ? ["-c", "user.name=Agent office runner", "-c", "user.email=runner@agent-office-sims.invalid"] : [];
      await git(dir, [...who, "commit", "--quiet", "--no-verify", "-m", message]);
      // Never forced: a branch someone pushed to since is refused, and looked at again.
      await git(dir, ["push", "--quiet", "--no-verify", "origin", `HEAD:refs/heads/${state.headRef}`]);
      return git(dir, ["rev-parse", "HEAD"]);
    },
  };
}
