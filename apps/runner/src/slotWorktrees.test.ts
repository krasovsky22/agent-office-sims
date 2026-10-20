/**
 * A worktree per task, the issue's acceptance against a temporary bare
 * origin: a task's worktree is cut from fresh origin, kept when it is dirty
 * or holds unpushed commits, removed when clean, strays are reported, and a
 * restarted runner takes back what its last run left. The last case runs the
 * slot pool and the mock agent over it with the data dir inside a
 * developer's checkout, which is never touched.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RunnerCommand } from "@sim/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createMockAgent } from "./agents/mock.js";
import { type GitFixture, gitFixture } from "./gitFixture.js";
import { SlotWorktrees } from "./slotWorktrees.js";
import { SlotPool } from "./slots.js";
import { Worktrees } from "./worktrees.js";

let fixture: GitFixture;
let logged: string[];

let template: GitFixture;

beforeAll(() => {
  template = gitFixture();
});

afterAll(() => {
  template.cleanup();
});

beforeEach(() => {
  fixture = template.copy();
  logged = [];
});

afterEach(() => {
  fixture.cleanup();
});

/** A runner's worktrees as it boots: a new `Worktrees` and state read from its data dir. */
function boot(dataDir = fixture.dataDir) {
  const worktrees = new Worktrees({
    repoDir: join(dataDir, "repo"),
    worktreesDir: join(dataDir, "worktrees"),
    ceilingDir: dataDir,
    clone: fixture.clone,
  });
  const slots = new SlotWorktrees({
    worktrees,
    stateFile: join(dataDir, "worktrees.json"),
    log: (line) => logged.push(line),
  });
  return { worktrees, slots };
}

function state(dataDir = fixture.dataDir): unknown {
  return JSON.parse(readFileSync(join(dataDir, "worktrees.json"), "utf8"));
}

describe("SlotWorktrees", () => {
  it("opens a task's worktree from fresh origin and records it", async () => {
    const { slots } = boot();
    await slots.reattach();
    const merged = fixture.merge("fix.txt");
    // Long enough after the clone for its fetch to be stale: a new runner.
    const { slots: later } = boot();
    const path = await later.open("slot-1", 39);
    expect(path).toBe(join(fixture.dataDir, "worktrees", "issue-39-slot-1"));
    expect(fixture.git(path, "rev-parse", "HEAD")).toBe(merged);
    expect(state()).toEqual({ worktrees: [{ slotId: "slot-1", issueNumber: 39, base: merged }] });
    expect(logged).toContain(`slot-1 made a worktree for #39 at ${path}, on sims/issue-39-slot-1 from ${merged.slice(0, 12)}`);
  });

  it("removes a clean worktree when its task ends", async () => {
    const { slots } = boot();
    const path = await slots.open("slot-1", 39);
    await slots.close("slot-1", 39);
    expect(existsSync(path)).toBe(false);
    expect(fixture.git(join(fixture.dataDir, "repo"), "branch", "--list", "sims/*")).toBe("");
    expect(state()).toEqual({ worktrees: [] });
  });

  it("keeps a dirty worktree, says why, and gives it back for the same issue", async () => {
    const { slots } = boot();
    const path = await slots.open("slot-1", 39);
    writeFileSync(join(path, "draft.txt"), "draft");
    await slots.close("slot-1", 39);
    expect(existsSync(join(path, "draft.txt"))).toBe(true);
    expect(logged).toContain(`slot-1 keeps its worktree for #39 at ${path}: 1 uncommitted change`);
    expect(slots.current()).toHaveLength(1);

    expect(await slots.open("slot-1", 39)).toBe(path);
    expect(existsSync(join(path, "draft.txt"))).toBe(true);
    // Another issue on the same slot gets a worktree of its own.
    expect(await slots.open("slot-1", 40)).toBe(join(fixture.dataDir, "worktrees", "issue-40-slot-1"));
  });

  it("keeps a worktree with unpushed commits", async () => {
    const { slots } = boot();
    const path = await slots.open("slot-2", 39);
    fixture.commit(path, "work.txt");
    await slots.close("slot-2", 39);
    expect(existsSync(path)).toBe(true);
    expect(logged).toContain(`slot-2 keeps its worktree for #39 at ${path}: 1 unpushed commit`);
  });

  it("discards a cancelled task's worktree and branch, uncommitted changes and unpushed commits included", async () => {
    const { slots } = boot();
    const path = await slots.open("slot-1", 39);
    fixture.commit(path, "work.txt");
    writeFileSync(join(path, "draft.txt"), "draft");
    const discarded: string[][] = [];
    await slots.close("slot-1", 39, async (branch, cwd) => {
      discarded.push([branch, cwd]);
    });
    expect(discarded).toEqual([["sims/issue-39-slot-1", join(fixture.dataDir, "repo")]]);
    expect(existsSync(path)).toBe(false);
    expect(fixture.git(join(fixture.dataDir, "repo"), "branch", "--list", "sims/*")).toBe("");
    expect(state()).toEqual({ worktrees: [] });
    expect(logged).toContain("slot-1 removed its worktree for #39: cancelled, discarding 1 uncommitted change, 1 unpushed commit");
    // Nothing of it comes back with the issue.
    expect(existsSync(join(await slots.open("slot-1", 39), "work.txt"))).toBe(false);
  });

  it("discards a cancelled task's branch on GitHub even once its worktree is gone", async () => {
    const { slots } = boot();
    await slots.open("slot-1", 39);
    await slots.close("slot-1", 39);
    expect(slots.current()).toEqual([]);
    const discarded: string[] = [];
    await slots.close("slot-1", 39, async (branch) => {
      discarded.push(branch);
    });
    expect(discarded).toEqual(["sims/issue-39-slot-1"]);
  });

  it("discards a cancelled task's worktree before the same issue opens it again", async () => {
    const { slots } = boot();
    const path = await slots.open("slot-1", 39);
    writeFileSync(join(path, "draft.txt"), "draft");
    let release = (): void => undefined;
    const github = new Promise<void>((resolve) => (release = resolve));
    const closing = slots.close("slot-1", 39, () => github);
    const opening = slots.open("slot-1", 39);
    release();
    await closing;
    expect(existsSync(join(await opening, "draft.txt"))).toBe(false);
  });

  it("gives up a worktree stopped while it was being made only once it is there", async () => {
    const { slots } = boot();
    const opening = slots.open("slot-1", 39);
    const closing = slots.close("slot-1", 39);
    const path = await opening;
    await closing;
    expect(existsSync(path)).toBe(false);
    expect(slots.current()).toEqual([]);
  });

  it("re-attaches after a restart: settles the tasks it cut short and keeps what holds work", async () => {
    const before = boot();
    await before.slots.reattach();
    const clean = await before.slots.open("slot-1", 39);
    const dirty = await before.slots.open("slot-2", 40);
    writeFileSync(join(dirty, "draft.txt"), "draft");
    const kept = await before.slots.open("slot-3", 41);
    fixture.commit(kept, "work.txt");
    await before.slots.close("slot-3", 41);
    // The runner dies here, with slot-1 and slot-2 mid-task.

    const after = boot();
    const { reattached, strays } = await after.slots.reattach();
    expect(reattached.map((record) => [record.slotId, record.issueNumber])).toEqual([
      ["slot-1", 39],
      ["slot-2", 40],
      ["slot-3", 41],
    ]);
    expect(strays).toEqual([]);
    expect(existsSync(clean)).toBe(false);
    expect(existsSync(join(dirty, "draft.txt"))).toBe(true);
    expect(existsSync(kept)).toBe(true);
    expect(after.slots.current().map((record) => record.slotId)).toEqual(["slot-2", "slot-3"]);
    expect(logged).toContain("re-attached slot-1 to #39, slot-2 to #40, slot-3 to #41");

    // The same issue on the same slot picks its work up again.
    expect(await after.slots.open("slot-3", 41)).toBe(kept);
    expect(existsSync(join(kept, "work.txt"))).toBe(true);
  });

  it("forgets a worktree whose folder went while it was down", async () => {
    const before = boot();
    const path = await before.slots.open("slot-1", 39);
    fixture.git(join(fixture.dataDir, "repo"), "worktree", "remove", "--force", path);

    const after = boot();
    expect((await after.slots.reattach()).reattached).toEqual([]);
    expect(after.slots.current()).toEqual([]);
    expect(logged).toContain("slot-1's worktree for #39 is gone; forgetting it");
  });

  it("reports strays at startup and leaves them alone", async () => {
    const { worktrees, slots } = boot();
    await slots.reattach();
    // A worktree no record names, a folder git does not know, and a branch with no worktree.
    const unknown = await worktrees.create(50, "slot-9");
    const folder = join(fixture.dataDir, "worktrees", "left-by-hand");
    mkdirSync(folder);
    fixture.git(join(fixture.dataDir, "repo"), "branch", "sims/issue-51-slot-9", "origin/main");

    const { strays } = await boot().slots.reattach();
    expect(strays).toEqual([unknown.path, folder, "sims/issue-51-slot-9"]);
    expect(logged).toContain(`left alone, not the runner's to remove: ${strays.join(", ")}`);
    expect(existsSync(unknown.path)).toBe(true);
    expect(existsSync(folder)).toBe(true);
  });

  it("reads an unreadable state file as none, so its worktrees are strays rather than removed", async () => {
    const before = boot();
    const path = await before.slots.open("slot-1", 39);
    writeFileSync(join(fixture.dataDir, "worktrees.json"), "{ not json");

    const after = boot();
    expect((await after.slots.reattach()).strays).toEqual([path]);
    expect(existsSync(path)).toBe(true);
    expect(logged.some((line) => line.startsWith(`could not read ${join(fixture.dataDir, "worktrees.json")}`))).toBe(true);
  });

  it("logs, rather than throws, a clone it cannot make at boot", async () => {
    const slots = new SlotWorktrees({
      worktrees: new Worktrees({
        repoDir: join(fixture.dataDir, "repo"),
        worktreesDir: join(fixture.dataDir, "worktrees"),
        clone: async () => {
          throw new Error("gh: not logged in");
        },
      }),
      stateFile: join(fixture.dataDir, "worktrees.json"),
      log: (line) => logged.push(line),
    });
    expect(await slots.reattach()).toEqual({ reattached: [], strays: [] });
    expect(logged).toEqual(["could not check the worktrees: could not clone the repository: gh: not logged in"]);
    await expect(slots.open("slot-1", 39)).rejects.toThrow("could not clone the repository: gh: not logged in");
  });
});

describe("the slot pool and mock agent in task worktrees", () => {
  const START: RunnerCommand = {
    id: "command-1",
    slotId: "slot-1",
    kind: "start",
    issueNumber: 39,
    title: "Night shift",
    url: "https://github.com/krasovsky22/agent-office-sims/issues/39",
    note: "",
    requestedBy: "Dana",
  };
  const STEP_MS = 50;

  async function until(done: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 400 && !done(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(done()).toBe(true);
  }

  it("works a task in its own worktree, keeps its commit, and never touches the developer's checkout", async () => {
    // The data dir sits inside the developer's own checkout.
    const dataDir = join(fixture.developer, ".sim-runner");
    mkdirSync(dataDir);
    const developerHead = fixture.git(fixture.developer, "rev-parse", "HEAD");
    const { slots: workspaces } = boot(dataDir);
    await workspaces.reattach();
    const pool = new SlotPool({
      count: 2,
      agent: createMockAgent({ outcome: "failed", stepMs: STEP_MS }),
      workspaces,
      taskTimeoutMs: 60_000,
    });

    pool.handle(START);
    // It commits, then waits on a person until a prompt answers it.
    await until(() => pool.report()[0]?.status === "needs-input");
    pool.handle({ id: "command-answer", slotId: "slot-1", kind: "prompt", text: "Go ahead.", requestedBy: "Dana" });
    await until(() => pool.pendingEvents().some((event) => event.kind === "failed"));
    await workspaces.settled();
    const path = join(dataDir, "worktrees", "issue-39-slot-1");
    expect(fixture.git(path, "log", "-1", "--format=%s %an")).toBe("mock: work on #39 Sims mock agent");
    expect(readFileSync(join(path, ".sims-mock", "issue-39.md"), "utf8")).toMatch(/^# Night shift\n/);
    expect(logged).toContain(`slot-1 keeps its worktree for #39 at ${path}: 1 unpushed commit`);

    // Stopped before it writes anything, the work leaves nothing to keep.
    pool.handle({ ...START, id: "command-2", slotId: "slot-2", issueNumber: 40 });
    await until(() => pool.report()[1]?.status === "working");
    pool.handle({ id: "command-3", slotId: "slot-2", kind: "stop", reason: "" });
    // Its worktree is closed once its agent has exited, a moment after the stop.
    await new Promise((resolve) => setImmediate(resolve));
    await workspaces.settled();
    expect(existsSync(join(dataDir, "worktrees", "issue-40-slot-2"))).toBe(false);
    expect(workspaces.current().map((record) => record.issueNumber)).toEqual([39]);

    expect(fixture.git(fixture.developer, "rev-parse", "HEAD")).toBe(developerHead);
    expect(fixture.git(fixture.developer, "worktree", "list").split("\n")).toHaveLength(1);
    expect(fixture.git(fixture.developer, "branch", "--format=%(refname:short)")).toBe("main");
    expect(fixture.git(fixture.developer, "status", "--porcelain")).toBe("?? .sim-runner/");
  });
});
