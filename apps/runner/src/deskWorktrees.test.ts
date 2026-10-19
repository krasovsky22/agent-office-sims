/**
 * The desk sessions' worktrees: a fresh scratch one per session, discarded as
 * it ends, and any a restart left discarded as the runner starts.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deskWorktrees } from "./deskWorktrees.js";

let root: string;
let asked: string[];
const worktrees = {
  createScratch: async (path: string) => {
    asked.push(`create ${path}`);
    return path;
  },
  removeScratch: async (path: string) => {
    asked.push(`remove ${path}`);
    return path.endsWith("stuck") ? "locked" : undefined;
  },
};

beforeEach(() => {
  root = join(mkdtempSync(join(tmpdir(), "desk-worktrees-")), "desks");
  asked = [];
});

afterEach(() => {
  rmSync(join(root, ".."), { recursive: true, force: true });
});

describe("deskWorktrees", () => {
  it("makes a fresh scratch worktree per session, and discards it as the session ends", async () => {
    const desks = deskWorktrees({ worktrees, root, now: () => 1700 });
    const workdir = await desks.open("slot-2");
    expect(workdir).toBe(join(root, "slot-2-1700"));
    await desks.close(workdir);
    expect(asked).toEqual([`create ${workdir}`, `remove ${workdir}`]);
  });

  it("discards what a restart left, and logs what it could not", async () => {
    mkdirSync(join(root, "slot-1-1"), { recursive: true });
    mkdirSync(join(root, "slot-2-stuck"), { recursive: true });
    const log = vi.fn();
    deskWorktrees({ worktrees, root, log });
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(2));
    expect(asked.sort()).toEqual([`remove ${join(root, "slot-1-1")}`, `remove ${join(root, "slot-2-stuck")}`]);
    expect(log).toHaveBeenCalledWith("could not remove slot-2-stuck: locked");
  });

  it("logs a worktree it could not discard as a session ends", async () => {
    const log = vi.fn();
    const desks = deskWorktrees({ worktrees, root, log });
    await desks.close(join(root, "slot-1-stuck"));
    expect(log).toHaveBeenCalledWith(`could not remove the desk session's worktree at ${join(root, "slot-1-stuck")}: locked`);
  });
});
