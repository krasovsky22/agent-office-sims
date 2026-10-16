/**
 * The runner's git plumbing against a temporary bare origin: its clone, a
 * worktree per task cut from what origin has now, what removing one would
 * lose, removing it, and listing what is in its worktrees dir.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type GitFixture, gitFixture } from "./gitFixture.js";
import { Worktrees, describeWork } from "./worktrees.js";

/** How long a fetch stays fresh, as `Worktrees` counts it. */
const FETCH_FRESH_MS = 15_000;

let fixture: GitFixture;
const clock = { now: 1_000_000 };

beforeEach(() => {
  fixture = gitFixture();
});

afterEach(() => {
  fixture.cleanup();
});

function worktrees(dataDir = fixture.dataDir, logged: string[] = []): Worktrees {
  return new Worktrees({
    repoDir: join(dataDir, "repo"),
    worktreesDir: join(dataDir, "worktrees"),
    ceilingDir: dataDir,
    clone: fixture.clone,
    log: (line) => logged.push(line),
    now: () => clock.now,
  });
}

describe("Worktrees", () => {
  it("clones once, and cuts a worktree on its own branch from origin as it is now", async () => {
    const trees = worktrees();
    expect(trees.cloned()).toBe(false);
    await Promise.all([trees.ready(), trees.ready()]);
    expect(trees.cloned()).toBe(true);
    expect(existsSync(join(fixture.dataDir, "repo.partial"))).toBe(false);

    // A clone is as fresh as a fetch.
    expect(trees.fetch()).toBeUndefined();
    // Merged on origin after the clone, once that is no longer fresh.
    const merged = fixture.merge("fix.txt");
    clock.now += FETCH_FRESH_MS;
    const fetching = trees.fetch();
    expect(fetching).toBeDefined();
    await fetching;
    // A burst of starts shares that fetch.
    expect(trees.fetch()).toBeUndefined();

    const made = await trees.create(39, "slot-1");
    expect(made.branch).toBe("sims/issue-39-slot-1");
    expect(made.path).toBe(join(fixture.dataDir, "worktrees", "issue-39-slot-1"));
    expect(made.base).toBe(merged);
    expect(fixture.git(made.path, "rev-parse", "HEAD")).toBe(merged);
    expect(fixture.git(made.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("sims/issue-39-slot-1");
    expect(existsSync(join(made.path, "fix.txt"))).toBe(true);
    // No upstream, so a bare `git push` from it can never land on main.
    expect(() => fixture.git(made.path, "rev-parse", "--abbrev-ref", "@{upstream}")).toThrow();
  });

  it("still makes a worktree from its last fetch when origin cannot be reached, and says so once", async () => {
    const logged: string[] = [];
    const trees = worktrees(fixture.dataDir, logged);
    await trees.ready();
    const head = fixture.git(join(fixture.dataDir, "repo"), "rev-parse", "origin/main");
    fixture.git(join(fixture.dataDir, "repo"), "remote", "set-url", "origin", join(fixture.root, "nowhere.git"));
    clock.now += FETCH_FRESH_MS;
    await trees.fetch();
    clock.now += FETCH_FRESH_MS;
    await trees.fetch();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^could not fetch origin, so new worktrees start from its last fetch: /);
    expect((await trees.create(39, "slot-1")).base).toBe(head);
  });

  it("says what removing a worktree would lose: uncommitted changes, then unpushed commits", async () => {
    const trees = worktrees();
    await trees.ready();
    const made = await trees.create(39, "slot-1");
    expect(await trees.wouldLose(made)).toBe("");

    writeFileSync(join(made.path, "draft.txt"), "draft");
    expect(await trees.inspect(made)).toEqual({ exists: true, dirty: 1, unpushed: 0 });
    expect(await trees.wouldLose(made)).toBe("1 uncommitted change");

    fixture.git(made.path, "add", "--all");
    fixture.git(made.path, "commit", "--quiet", "-m", "draft");
    fixture.commit(made.path, "second.txt");
    expect(await trees.wouldLose(made)).toBe("2 unpushed commits");

    // Pushed, it is on a remote: nothing would be lost.
    fixture.git(made.path, "push", "--quiet", "origin", "sims/issue-39-slot-1");
    expect(await trees.wouldLose(made)).toBe("");
  });

  it("counts what it cannot check as something to lose", async () => {
    const trees = worktrees();
    await trees.ready();
    const ref = trees.refFor(40, "slot-1");
    expect(await trees.wouldLose(ref)).toMatch(/^could not check it \(/);
    expect(describeWork({ exists: true, dirty: 2, unpushed: 1 })).toBe("2 uncommitted changes, 1 unpushed commit");
  });

  it("removes a worktree with its branch, even a locked one", async () => {
    const trees = worktrees();
    await trees.ready();
    const made = await trees.create(39, "slot-1");
    expect(await trees.remove(made)).toBeUndefined();
    expect(existsSync(made.path)).toBe(false);
    expect((await trees.list()).branches).toEqual([]);

    const locked = await trees.create(40, "slot-2");
    fixture.git(join(fixture.dataDir, "repo"), "worktree", "lock", locked.path);
    expect(await trees.remove(locked)).toBeUndefined();
    expect(existsSync(locked.path)).toBe(false);
    expect((await trees.list()).worktrees).toEqual([]);
  });

  it("checks a branch with work left on it out again, and makes one with none again from origin", async () => {
    const trees = worktrees();
    await trees.ready();
    const first = await trees.create(39, "slot-1");
    const work = fixture.commit(first.path, "work.txt");
    // The folder goes, as if deleted by hand; the branch and its commit stay.
    fixture.git(join(fixture.dataDir, "repo"), "worktree", "remove", "--force", first.path);
    const again = await trees.create(39, "slot-1");
    expect(fixture.git(again.path, "rev-parse", "HEAD")).toBe(work);

    const other = await trees.create(40, "slot-1");
    fixture.git(join(fixture.dataDir, "repo"), "worktree", "remove", "--force", other.path);
    const merged = fixture.merge("fix.txt");
    clock.now += FETCH_FRESH_MS;
    await trees.fetch();
    expect((await trees.create(40, "slot-1")).base).toBe(merged);
  });

  it("lists its worktrees, every sims/ branch, and folders git does not know", async () => {
    const trees = worktrees();
    await trees.ready();
    const made = await trees.create(39, "slot-1");
    mkdirSync(join(fixture.dataDir, "worktrees", "left-by-hand"));
    writeFileSync(join(fixture.dataDir, "worktrees", "a-file"), "");
    expect(await trees.list()).toEqual({
      worktrees: [{ path: made.path, branch: "sims/issue-39-slot-1" }],
      branches: ["sims/issue-39-slot-1"],
      strays: [join(fixture.dataDir, "worktrees", "left-by-hand")],
    });
  });

  it("never runs git on a repository above its data dir, such as the developer's own checkout", async () => {
    // The data dir sits inside the developer's checkout, and holds no clone yet.
    const dataDir = join(fixture.developer, ".sim-runner");
    mkdirSync(join(dataDir, "repo"), { recursive: true });
    const trees = worktrees(dataDir);
    await expect(trees.create(39, "slot-1")).rejects.toThrow(/not a git repository/);
    expect(trees.fetch()).toBeUndefined();
    expect(fixture.git(fixture.developer, "worktree", "list", "--porcelain").split("\n")[0]).toBe(
      `worktree ${fixture.developer}`,
    );
    expect(fixture.git(fixture.developer, "worktree", "list").split("\n")).toHaveLength(1);
    expect(fixture.git(fixture.developer, "branch", "--format=%(refname:short)")).toBe("main");
  });

  it("refuses a clone that made no repository, and leaves nothing behind", async () => {
    const trees = new Worktrees({
      repoDir: join(fixture.dataDir, "repo"),
      worktreesDir: join(fixture.dataDir, "worktrees"),
      clone: async (target) => {
        mkdirSync(target);
      },
    });
    await expect(trees.ready()).rejects.toThrow("could not clone the repository: the clone made no repository");
    expect(existsSync(join(fixture.dataDir, "repo"))).toBe(false);
    expect(existsSync(join(fixture.dataDir, "repo.partial"))).toBe(false);
  });
});
