// Adapted from agent-office (MIT, Copyright (c) 2026 AgentSystemLabs): src/server/worktrees.ts. See THIRD_PARTY_NOTICES.md.
/**
 * Git plumbing for the worktrees the runner gives its tasks: one clone of the
 * repository in the runner's data dir, and a worktree on a branch of its own
 * for each task, cut from what origin has now.
 *
 * Every git command runs inside the data dir with the data dir as a ceiling,
 * so a missing or broken clone is an error rather than a command run on
 * whatever repository happens to sit above it, such as a developer's own
 * checkout.
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, realpathSync, renameSync, statSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Every task branch is `sims/issue-<n>-<slot>`. */
export const BRANCH_PREFIX = "sims/";

/** A fetch this recent is fresh enough for the next worktree: a burst of starts shares one. */
const FETCH_FRESH_MS = 15_000;
const FETCH_TIMEOUT_MS = 15_000;
const CLONE_TIMEOUT_MS = 10 * 60_000;
const GIT_TIMEOUT_MS = 60_000;

/** Makes the runner's clone of the repository at `target`, a folder that does not exist yet. */
export type CloneRepository = (target: string, env: NodeJS.ProcessEnv) => Promise<void>;

/**
 * Clones `owner/name` with the GitHub CLI, which reads its own credentials
 * (`GH_TOKEN`, or `gh auth login`), so a private repository needs nothing of
 * the runner's.
 */
export function ghClone(repo: string): CloneRepository {
  return async (target, env) => {
    await execFileP("gh", ["repo", "clone", repo, target, "--", "--quiet"], { env, timeout: CLONE_TIMEOUT_MS });
  };
}

export interface WorktreeRef {
  /** Absolute. */
  readonly path: string;
  readonly branch: string;
}

export interface MadeWorktree extends WorktreeRef {
  /** The commit it was branched from. */
  readonly base: string;
}

export interface WorktreeState {
  readonly exists: boolean;
  /** Uncommitted changes, untracked files included. */
  readonly dirty: number;
  /** Commits on its branch that no remote has. */
  readonly unpushed: number;
  /** Why it could not be checked, when it could not. */
  readonly error?: string;
}

export interface ListedWorktree {
  /** Absolute, symlinks resolved. */
  readonly path: string;
  readonly branch: string | undefined;
}

export interface WorktreesOptions {
  /** The runner's clone, made by `clone` when missing. */
  readonly repoDir: string;
  /** Where the task worktrees go; the only place this class deletes on its own. */
  readonly worktreesDir: string;
  /**
   * Above which git looks for no repository: the runner's data dir. Defaults
   * to the folder `repoDir` is in.
   */
  readonly ceilingDir?: string;
  readonly clone: CloneRepository;
  readonly log?: (line: string) => void;
  /** Injected so a test can let a fetch go stale. */
  readonly now?: () => number;
}

export class Worktrees {
  private readonly repoDir: string;
  private readonly worktreesDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private cloning: Promise<void> | undefined;
  private fetchedAt = 0;
  private fetching: Promise<void> | undefined;
  /** The last fetch's error, so the log says it once rather than on every start. */
  private fetchError: string | undefined;

  public constructor(private readonly options: WorktreesOptions) {
    this.repoDir = resolve(options.repoDir);
    this.worktreesDir = resolve(options.worktreesDir);
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? Date.now;
    this.env = {
      ...process.env,
      // Never stop to ask for a password: there is nobody at the runner's terminal to type it.
      GIT_TERMINAL_PROMPT: "0",
      GIT_CEILING_DIRECTORIES: real(options.ceilingDir ?? dirname(this.repoDir)),
    };
  }

  /** Where a task's worktree goes, and its branch. */
  public refFor(issueNumber: number, slotId: string): WorktreeRef {
    const name = `issue-${issueNumber}-${slotId}`;
    return { path: join(real(this.worktreesDir), name), branch: `${BRANCH_PREFIX}${name}` };
  }

  /** Whether the runner's clone is there. */
  public cloned(): boolean {
    return existsSync(join(this.repoDir, ".git"));
  }

  /**
   * Makes the runner's clone when it is missing. It is made beside its final
   * place and moved in once whole, so a clone cut short is never taken for one.
   */
  public ready(): Promise<void> {
    if (this.cloned()) {
      return Promise.resolve();
    }
    this.cloning ??= this.makeClone().finally(() => {
      this.cloning = undefined;
    });
    return this.cloning;
  }

  private async makeClone(): Promise<void> {
    const partial = `${this.repoDir}.partial`;
    await rm(partial, { recursive: true, force: true });
    await mkdir(dirname(this.repoDir), { recursive: true });
    try {
      await this.options.clone(partial, this.env);
      if (!existsSync(join(partial, ".git"))) {
        throw new Error("the clone made no repository");
      }
    } catch (error) {
      await rm(partial, { recursive: true, force: true });
      throw new Error(`could not clone the repository: ${gitError(error)}`);
    }
    renameSync(partial, this.repoDir);
    this.fetchedAt = this.now();
  }

  /**
   * Brings origin's default branch up to date, so the next worktree starts
   * from what is really there (a pull request merged since, say) rather than
   * from the clone's last look. Resolves either way: offline, worktrees start
   * from the last fetch. Undefined when there is nothing to wait for.
   */
  public fetch(): Promise<void> | undefined {
    if (this.fetching !== undefined) {
      return this.fetching;
    }
    if (this.now() - this.fetchedAt < FETCH_FRESH_MS || !this.cloned()) {
      return undefined;
    }
    this.fetching = this.defaultBranch()
      .then((branch) => this.git(["fetch", "--quiet", "--no-tags", "origin", branch], this.repoDir, FETCH_TIMEOUT_MS))
      .then(
        () => {
          this.fetchError = undefined;
        },
        (error: unknown) => {
          // Its first complaint says what is wrong; the last line is advice about access rights.
          const stderr = String((error as { stderr?: string }).stderr ?? "");
          const why = stderr.split("\n").find((line) => /^(fatal|error):/.test(line)) ?? gitError(error);
          if (why !== this.fetchError) {
            this.log(`could not fetch origin, so new worktrees start from its last fetch: ${why}`);
          }
          this.fetchError = why;
        },
      )
      .then(() => {
        this.fetchedAt = this.now();
        this.fetching = undefined;
      });
    return this.fetching;
  }

  /** The branch origin's HEAD names, as the clone recorded it: `main`, usually. */
  public async defaultBranch(): Promise<string> {
    // `--quiet` makes "not a symbolic ref" a bare exit 1; anything else, such as no repository, is an error.
    const ref = await this.git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).catch((error: unknown) => {
      if ((error as { code?: unknown }).code === 1) {
        return "";
      }
      throw error;
    });
    if (!ref.startsWith("origin/")) {
      throw new Error("the clone does not know origin's default branch; run `git remote set-head origin --auto` in it");
    }
    return ref.slice("origin/".length);
  }

  /** Where a new worktree starts: origin's copy of the default branch, which its pull request goes to. */
  public async startPoint(): Promise<string> {
    const branch = await this.defaultBranch();
    return this.git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}^{commit}`]);
  }

  /**
   * A new worktree for a task, on its own branch from {@link startPoint}.
   * A branch left from an earlier run of the same task with work only it
   * has is checked out again rather than replaced; one with nothing of its
   * own is made again from origin.
   */
  public async create(issueNumber: number, slotId: string): Promise<MadeWorktree> {
    const ref = this.refFor(issueNumber, slotId);
    try {
      const base = await this.startPoint();
      await mkdir(this.worktreesDir, { recursive: true });
      await this.git(["worktree", "prune"]);
      if (await this.hasBranch(ref.branch)) {
        if ((await this.unpushed(ref.branch)) > 0) {
          await this.git(["worktree", "add", ref.path, ref.branch]);
          return { ...ref, base: await this.git(["merge-base", base, ref.branch]).catch(() => base) };
        }
        await this.git(["branch", "-D", ref.branch]);
      }
      // No upstream: a bare `git push` from the worktree must never land on the default branch.
      await this.git(["worktree", "add", "--no-track", "-b", ref.branch, ref.path, base]);
      return { ...ref, base };
    } catch (error) {
      throw new Error(`could not create a git worktree: ${gitError(error)}`);
    }
  }

  /** What a worktree holds that would be lost with it: uncommitted changes, and commits no remote has. */
  public async inspect(ref: WorktreeRef): Promise<WorktreeState> {
    const exists = existsSync(ref.path);
    let dirty = 0;
    try {
      if (exists) {
        dirty = (await this.git(["status", "--porcelain"], ref.path)).split("\n").filter(Boolean).length;
      }
      return { exists, dirty, unpushed: await this.unpushed(ref.branch) };
    } catch (error) {
      return { exists, dirty, unpushed: 0, error: gitError(error) };
    }
  }

  /** What removing a worktree would lose, as {@link describeWork} says it; `""` when nothing. */
  public async wouldLose(ref: WorktreeRef): Promise<string> {
    return describeWork(await this.inspect(ref));
  }

  /** Deletes a worktree's folder and its branch. Says what went wrong, if anything. */
  public async remove(ref: WorktreeRef): Promise<string | undefined> {
    try {
      if (existsSync(ref.path)) {
        try {
          await this.git(["worktree", "remove", "--force", "--force", ref.path]);
        } catch (error) {
          // Git will not (a lock, say), but it is the runner's own folder: take it out by hand.
          if (!this.owns(ref.path)) {
            throw error;
          }
          await rm(ref.path, { recursive: true, force: true });
        }
      }
      // Forget worktrees whose folders are gone: this one, and any deleted by hand.
      await this.git(["worktree", "prune"]);
      if (await this.hasBranch(ref.branch)) {
        await this.git(["branch", "-D", ref.branch]);
      }
      return undefined;
    } catch (error) {
      return gitError(error);
    }
  }

  /**
   * The worktrees git has in the worktrees dir, every `sims/` branch, and
   * folders there git does not know.
   */
  public async list(): Promise<{ worktrees: ListedWorktree[]; branches: string[]; strays: string[] }> {
    const home = real(this.worktreesDir);
    const worktrees: { path: string; branch: string | undefined }[] = [];
    let current: { path: string; branch: string | undefined } | undefined;
    for (const line of (await this.git(["worktree", "list", "--porcelain"])).split("\n")) {
      if (line.startsWith("worktree ")) {
        const path = real(line.slice("worktree ".length));
        current = within(home, path) ? { path, branch: undefined } : undefined;
        if (current !== undefined) {
          worktrees.push(current);
        }
      } else if (current !== undefined && line.startsWith("branch ")) {
        current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      }
    }
    const branches = (await this.git(["for-each-ref", "--format=%(refname:short)", `refs/heads/${BRANCH_PREFIX}`]))
      .split("\n")
      .filter(Boolean);
    const known = new Set(worktrees.map((worktree) => worktree.path));
    const strays = existsSync(home)
      ? readdirSync(home)
          .map((name) => join(home, name))
          .filter((path) => !known.has(path) && isDir(path))
      : [];
    return { worktrees, branches, strays };
  }

  /** True for a folder inside the worktrees dir, the only place this class deletes on its own. */
  public owns(path: string): boolean {
    return within(real(this.worktreesDir), real(path));
  }

  private async hasBranch(branch: string): Promise<boolean> {
    return this.git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(
      () => true,
      () => false,
    );
  }

  /** Commits on `branch` that no remote has: what deleting the branch would lose. */
  private async unpushed(branch: string): Promise<number> {
    return Number(await this.git(["rev-list", "--count", branch, "--not", "--remotes", "--"]));
  }

  private async git(args: readonly string[], cwd = this.repoDir, timeout = GIT_TIMEOUT_MS): Promise<string> {
    const { stdout } = await execFileP("git", args, {
      cwd,
      env: this.env,
      encoding: "utf8",
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  }
}

/** Why removing this would lose something ("2 uncommitted changes, 1 unpushed commit"), or `""` when it would not. */
export function describeWork(state: WorktreeState): string {
  if (state.error !== undefined) {
    return `could not check it (${state.error})`;
  }
  const parts: string[] = [];
  if (state.dirty > 0) {
    parts.push(`${state.dirty} uncommitted ${state.dirty === 1 ? "change" : "changes"}`);
  }
  if (state.unpushed > 0) {
    parts.push(`${state.unpushed} unpushed ${state.unpushed === 1 ? "commit" : "commits"}`);
  }
  return parts.join(", ");
}

/** The last line git printed, which is the one that says what is wrong. */
export function gitError(error: unknown): string {
  const { stderr, message } = error as { stderr?: string; message?: string };
  return (
    String(stderr || message || error)
      .trim()
      .split("\n")
      .filter(Boolean)
      .pop() ?? "git failed"
  );
}

/** A path with symlinks resolved, as git prints it, even for one that does not exist yet. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(resolve(path));
    return parent === resolve(path) ? parent : join(real(parent), basename(path));
  }
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
