/**
 * Test support: a temporary bare "origin", a developer's own checkout of it,
 * and an empty runner data dir beside them, so worktree tests run against real
 * git without the network or the machine's own repositories.
 *
 * The developer's checkout stands in for GitHub as well: whatever it pushes is
 * a pull request merged there, which the runner's clone has not fetched yet.
 *
 * Making one runs about nine git commands; a test file makes one in
 * `beforeAll` and {@link GitFixture.copy}s it per test, which runs none.
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { CloneRepository } from "./worktrees.js";

export interface GitFixture {
  /** The temporary folder everything is in; removed by {@link GitFixture.cleanup}. */
  readonly root: string;
  readonly origin: string;
  readonly developer: string;
  readonly dataDir: string;
  /** Runs git in `cwd` as a fixed identity, unsigned and without hooks, and returns what it printed. */
  git(cwd: string, ...args: string[]): string;
  /** Commits a file in `cwd` and returns the commit. */
  commit(cwd: string, file: string): string;
  /** Commits a file in the developer's checkout and pushes it to origin's `main`; returns the commit. */
  merge(file: string): string;
  /** Clones origin as `gh repo clone` would clone GitHub. */
  readonly clone: CloneRepository;
  /** A fresh fixture in a folder of its own, as this one is now. */
  copy(): GitFixture;
  cleanup(): void;
}

function newRoot(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "sim-runner-worktrees-")));
}

export function gitFixture(): GitFixture {
  const root = newRoot();
  const fixture = fixtureAt(root);
  const { git, commit, origin, developer } = fixture;
  git(root, "init", "--quiet", "--bare", "-b", "main", origin);
  git(root, "clone", "--quiet", origin, developer);
  git(developer, "checkout", "--quiet", "-b", "main");
  commit(developer, "README.md");
  git(developer, "push", "--quiet", "--no-verify", "-u", "origin", "main");
  // As a clone of GitHub would have it, so the checkout is one the runner's worktrees could be cut from.
  git(developer, "remote", "set-head", "origin", "main");
  mkdirSync(fixture.dataDir);
  return fixture;
}

function fixtureAt(root: string): GitFixture {
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync(
      "git",
      ["-c", "user.email=test@sims.invalid", "-c", "user.name=test", "-c", "commit.gpgsign=false", ...args],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  const commit = (cwd: string, file: string): string => {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), file);
    git(cwd, "add", "--all");
    git(cwd, "commit", "--quiet", "--no-verify", "-m", file);
    return git(cwd, "rev-parse", "HEAD");
  };

  const origin = join(root, "origin.git");
  const developer = join(root, "developer");
  const dataDir = join(root, "data");

  return {
    root,
    origin,
    developer,
    dataDir,
    git,
    commit,
    merge(file) {
      const sha = commit(developer, file);
      git(developer, "push", "--quiet", "--no-verify", "origin", "main");
      return sha;
    },
    clone: async (target) => {
      git(root, "clone", "--quiet", origin, target);
    },
    copy() {
      const copied = newRoot();
      cpSync(root, copied, { recursive: true });
      // The developer's checkout names origin by its absolute path, so the copy's must name its own.
      const config = join(copied, "developer", ".git", "config");
      writeFileSync(config, readFileSync(config, "utf8").replaceAll(root, copied));
      return fixtureAt(copied);
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
