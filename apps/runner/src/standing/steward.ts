/**
 * The GitHub and git side of the pull request steward, all of it the
 * runner's own: reading a pull request's merge state and checks, merging it,
 * and merging its base into its branch so an agent can resolve the conflicts,
 * then committing and pushing what the agent left.
 *
 * The merge is never an agent's: the runner reads the checks itself, asks
 * `stewardStep` in `@sim/shared` (whose `mergeGate` wants every required
 * check green and none failing), and merges with `--match-head-commit`, in a
 * method the repository allows, so a push after its
 * look can never be merged on the strength of the checks it read. An agent
 * resolving conflicts gets no GitHub identity and no shell; the runner
 * commits only the files that were in conflict, refuses any that still carry
 * conflict markers, and pushes without force, so a branch that moved since is
 * never overwritten. Git's hooks and fsmonitor are off for all of it: they
 * would be the pull request's code running on the runner's machine; and once
 * the agent has had the checkout, git is told its repository outright, never
 * reading it off a `.git` file the agent could have rewritten.
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
      state isDraft mergeable mergeStateStatus headRefOid headRefName baseRefName baseRefOid isCrossRepository
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

/** Which merges the repository allows, so the steward merges in one of them. */
const MERGE_METHODS_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed }
}`;

export type MergeMethod = "squash" | "merge" | "rebase";

/** The merge method to use off GitHub's answer: squashed where allowed, else a merge commit, else rebased. */
export function readMergeMethod(raw: unknown): MergeMethod {
  const repository = asRecord(asRecord(asRecord(raw)?.["data"])?.["repository"]);
  if (repository?.["squashMergeAllowed"] !== true && repository?.["mergeCommitAllowed"] === true) {
    return "merge";
  }
  if (repository?.["squashMergeAllowed"] !== true && repository?.["rebaseMergeAllowed"] === true) {
    return "rebase";
  }
  return "squash";
}

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
    baseSha: text(pull["baseRefOid"]).toLowerCase(),
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

/**
 * Why the runner would not go on with a pull request: `agent` for what the
 * agent resolving it left wrong, which it is shown and can put right;
 * `moved` for a pull request that changed under it, which its new head
 * starts over; `never` for what no second try changes.
 */
export class StewardRefusal extends Error {
  public constructor(
    message: string,
    public readonly kind: "agent" | "moved" | "never",
  ) {
    super(message);
  }
}

/** What git and GitHub say when the runner's identity may not do it: trying again changes nothing. */
const PERMISSION_DENIED = /permission|denied|forbidden|not authorized|\b403\b|resource not accessible/i;
/** GitHub answers a rate limit with a 403 too, but that one passes. */
const RATE_LIMITED = /rate limit|secondary|abuse/i;

/** Whether a refusal is one no second try gets past. */
export function deniedForGood(message: string): boolean {
  return PERMISSION_DENIED.test(message) && !RATE_LIMITED.test(message);
}

export interface StewardGithub {
  /** Rejects with why when GitHub could not be asked. */
  inspect(number: number): Promise<PullState>;
  /**
   * Merges it, in a method the repository allows, if its head is still
   * `headSha`; rejects with GitHub's why otherwise.
   *
   * @returns the method it merged in.
   */
  merge(number: number, headSha: string): Promise<MergeMethod>;
  /**
   * Checks the pull request's head out in the scratch worktree `dir` and
   * merges its base in, uncommitted.
   *
   * @returns the files left in conflict, none when it merged cleanly,
   * whether there was nothing to merge at all, and the worktree's own git
   * directory, read before anyone else touches the checkout.
   */
  startMerge(
    dir: string,
    number: number,
    state: PullState,
  ): Promise<{ readonly conflicts: readonly string[]; readonly upToDate: boolean; readonly gitDir: string }>;
  /**
   * Commits the merge with `files` as they are now, refusing any that still
   * carry a conflict marker, and pushes it to the pull request's branch,
   * with git told `gitDir`, the one `startMerge` read, outright. Its
   * refusals are {@link StewardRefusal}s, saying whose they are to fix.
   *
   * @returns the new head commit.
   */
  finishMerge(dir: string, gitDir: string, state: PullState, files: readonly string[], message: string): Promise<string>;
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
  /**
   * Git in a scratch worktree, hooks and fsmonitor off, and never looking
   * above the folder the scratch worktrees are in; given `gitDir`, never
   * looking for its repository at all.
   */
  const git = async (dir: string, args: readonly string[], gitDir?: string): Promise<string> =>
    run("git", [...(gitDir === undefined ? [] : ["--git-dir", gitDir, "--work-tree", dir]), "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
      cwd: dir,
      env: { ...(await options.env()), GIT_TERMINAL_PROMPT: "0", GIT_CEILING_DIRECTORIES: dirname(dir) },
    });
  const unmerged = async (dir: string, gitDir?: string): Promise<string[]> =>
    (await git(dir, ["diff", "--name-only", "--diff-filter=U", "-z"], gitDir)).split("\u0000").filter((path) => path !== "");

  return {
    async inspect(number) {
      const out = await gh(["api", "graphql", "-f", `query=${PULL_STATE_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${number}`]);
      return readPullState(JSON.parse(out) as unknown, number);
    },

    async merge(number, headSha) {
      const out = await gh(["api", "graphql", "-f", `query=${MERGE_METHODS_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`]);
      const method = readMergeMethod(JSON.parse(out) as unknown);
      await gh(["pr", "merge", String(number), "--repo", repo, `--${method}`, "--match-head-commit", headSha]);
      return method;
    },

    async startMerge(dir, number, state) {
      if (state.crossRepository || !BRANCH.test(state.headRef) || !BRANCH.test(state.baseRef)) {
        throw new StewardRefusal(`PR #${number}'s branches are not ones the runner pushes to`, "never");
      }
      const gitDir = await git(dir, ["rev-parse", "--absolute-git-dir"]);
      await git(dir, ["fetch", "--no-tags", "origin", `refs/heads/${state.baseRef}`]);
      const base = await git(dir, ["rev-parse", "FETCH_HEAD"]);
      await git(dir, ["fetch", "--no-tags", "origin", `refs/pull/${number}/head`]);
      const head = (await git(dir, ["rev-parse", "FETCH_HEAD"])).toLowerCase();
      if (head !== state.headSha) {
        throw new StewardRefusal(`PR #${number} moved to ${head.slice(0, 7)} while it was being looked at`, "moved");
      }
      await git(dir, ["checkout", "--quiet", "--detach", head]);
      try {
        const out = await git(dir, ["merge", "--no-ff", "--no-commit", base]);
        return { conflicts: [], upToDate: /already up to date/i.test(out), gitDir };
      } catch (error) {
        const conflicts = await unmerged(dir);
        if (conflicts.length === 0) {
          throw error;
        }
        return { conflicts, upToDate: false, gitDir };
      }
    },

    async finishMerge(dir, gitDir, state, files, message) {
      for (const file of files) {
        const path = headPath(dir, file);
        if (path === undefined) {
          throw new StewardRefusal(`${file} is not a path in the checkout`, "never");
        }
        let content = "";
        try {
          content = readFileSync(path, "utf8");
        } catch {
          // Deleted on purpose: one side removed it, and the agent kept that.
          continue;
        }
        if (CONFLICT_MARKER.test(content)) {
          throw new StewardRefusal(`${file} still has conflict markers`, "agent");
        }
      }
      if (files.length > 0) {
        await git(dir, ["add", "--all", "--", ...files], gitDir);
      }
      const left = await unmerged(dir, gitDir);
      if (left.length > 0) {
        throw new StewardRefusal(`still in conflict: ${left.join(", ")}`, "agent");
      }
      const email = await git(dir, ["config", "user.email"], gitDir).catch(() => "");
      const who = email === "" ? ["-c", "user.name=Agent office runner", "-c", "user.email=runner@agent-office-sims.invalid"] : [];
      await git(dir, [...who, "commit", "--quiet", "--no-verify", "-m", message], gitDir);
      try {
        // Never forced: a branch someone pushed to since is refused, and looked at again.
        await git(dir, ["push", "--quiet", "--no-verify", "origin", `HEAD:refs/heads/${state.headRef}`], gitDir);
      } catch (error) {
        const why = (error as Error).message;
        if (/\[rejected\]|non-fast-forward|fetch first/.test(why)) {
          throw new StewardRefusal(`the push was refused: ${state.headRef} moved since it was looked at`, "moved");
        }
        throw deniedForGood(why) ? new StewardRefusal(`the push was refused: ${why}`, "never") : error;
      }
      return git(dir, ["rev-parse", "HEAD"], gitDir);
    },
  };
}
