/**
 * The steward's GitHub and git side: GitHub's answer read into the merge
 * gate's terms, and, against real git, a conflicted merge of the base that is
 * committed only once its markers are gone and pushed only as a fast-forward.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { PullState } from "@sim/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type GitFixture, gitFixture } from "../gitFixture.js";
import { runCommand } from "../github.js";
import { createStewardGithub, readPullState } from "./steward.js";

describe("readPullState", () => {
  it("reads the merge state and each check, required or not", () => {
    const state = readPullState(
      {
        data: {
          repository: {
            pullRequest: {
              state: "OPEN",
              isDraft: false,
              mergeable: "MERGEABLE",
              mergeStateStatus: "CLEAN",
              headRefOid: "ABC1234",
              headRefName: "feature",
              baseRefName: "main",
              isCrossRepository: false,
              commits: {
                nodes: [
                  {
                    commit: {
                      statusCheckRollup: {
                        contexts: {
                          pageInfo: { hasNextPage: false },
                          nodes: [
                            { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS", isRequired: true },
                            { __typename: "CheckRun", name: "deploy", status: "COMPLETED", conclusion: "SKIPPED", isRequired: false },
                            { __typename: "CheckRun", name: "e2e", status: "IN_PROGRESS", conclusion: null, isRequired: false },
                            { __typename: "StatusContext", context: "legacy", state: "FAILURE", isRequired: false },
                          ],
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      },
      7,
    );
    expect(state).toEqual({
      open: true,
      draft: false,
      headSha: "abc1234",
      headRef: "feature",
      baseRef: "main",
      crossRepository: false,
      mergeable: "MERGEABLE",
      mergeState: "CLEAN",
      checks: [
        { name: "ci", state: "pass", required: true },
        { name: "deploy", state: "skipped", required: false },
        { name: "e2e", state: "pending", required: false },
        { name: "legacy", state: "fail", required: false },
      ],
      checksTruncated: false,
    });
  });

  it("reads a pull request with no checks as having none, and refuses one GitHub does not have", () => {
    const bare = readPullState({ data: { repository: { pullRequest: { state: "OPEN", commits: { nodes: [{ commit: { statusCheckRollup: null } }] } } } } }, 7);
    expect(bare.checks).toEqual([]);
    // Unsaid means a fork's: never pushed to.
    expect(bare.crossRepository).toBe(true);
    expect(() => readPullState({ data: { repository: { pullRequest: null } } }, 7)).toThrow("no pull request #7");
  });
});

describe("resolving a pull request's conflicts", () => {
  let fixture: GitFixture;
  let scratch: string;
  let state: PullState;

  beforeEach(() => {
    fixture = gitFixture();
    const { developer, git } = fixture;
    writeFileSync(join(developer, "a.txt"), "base\n");
    git(developer, "add", "a.txt");
    git(developer, "commit", "--quiet", "--no-verify", "-m", "base");
    git(developer, "push", "--quiet", "--no-verify", "origin", "main");
    git(developer, "checkout", "--quiet", "-b", "feature");
    writeFileSync(join(developer, "a.txt"), "feature\n");
    git(developer, "commit", "--quiet", "--no-verify", "-am", "feature");
    git(developer, "push", "--quiet", "--no-verify", "origin", "feature", "feature:refs/pull/7/head");
    const headSha = git(developer, "rev-parse", "HEAD");
    git(developer, "checkout", "--quiet", "main");
    writeFileSync(join(developer, "a.txt"), "main\n");
    git(developer, "commit", "--quiet", "--no-verify", "-am", "main");
    git(developer, "push", "--quiet", "--no-verify", "origin", "main");

    const clone = join(fixture.root, "clone");
    git(fixture.root, "clone", "--quiet", fixture.origin, clone);
    mkdirSync(join(fixture.dataDir, "standing-runs"));
    scratch = join(fixture.dataDir, "standing-runs", "fix7");
    git(clone, "worktree", "add", "--quiet", "--detach", scratch, "origin/main");
    state = {
      open: true,
      draft: false,
      headSha,
      headRef: "feature",
      baseRef: "main",
      crossRepository: false,
      mergeable: "CONFLICTING",
      mergeState: "DIRTY",
      checks: [],
      checksTruncated: false,
    };
  });

  afterEach(() => {
    fixture.cleanup();
  });

  // The machine's own git settings, a signing key say, kept out.
  const steward = () =>
    createStewardGithub({ repo: "o/r", env: async () => ({ ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }), run: runCommand });

  const originFeature = (): string => fixture.git(fixture.origin, "rev-parse", "refs/heads/feature");

  it("commits nothing with a conflict marker left in, then pushes the merge once resolved", async () => {
    const github = steward();
    expect(await github.startMerge(scratch, 7, state)).toEqual({ conflicts: ["a.txt"], upToDate: false });
    await expect(github.finishMerge(scratch, state, ["a.txt"], "Merge main into feature")).rejects.toThrow("a.txt still has conflict markers");
    expect(originFeature()).toBe(state.headSha);

    writeFileSync(join(scratch, "a.txt"), "main and feature\n");
    const head = await github.finishMerge(scratch, state, ["a.txt"], "Merge main into feature");
    expect(originFeature()).toBe(head);
    // A merge of the base onto the pull request's own head: a fast-forward of its branch.
    expect(fixture.git(fixture.origin, "rev-list", "--parents", "-n", "1", head).split(" ")).toContain(state.headSha);
  });

  it("never overwrites a branch someone pushed to since it looked", async () => {
    const github = steward();
    await github.startMerge(scratch, 7, state);
    const { developer, git } = fixture;
    git(developer, "checkout", "--quiet", "feature");
    writeFileSync(join(developer, "b.txt"), "more\n");
    git(developer, "add", "b.txt");
    git(developer, "commit", "--quiet", "--no-verify", "-m", "more");
    git(developer, "push", "--quiet", "--no-verify", "origin", "feature");
    const pushed = originFeature();

    writeFileSync(join(scratch, "a.txt"), "resolved\n");
    await expect(github.finishMerge(scratch, state, ["a.txt"], "Merge main into feature")).rejects.toThrow();
    expect(originFeature()).toBe(pushed);
  });

  it("refuses a pull request whose head moved, or from a fork", async () => {
    const github = steward();
    await expect(github.startMerge(scratch, 7, { ...state, headSha: "0".repeat(40) })).rejects.toThrow("moved");
    await expect(github.startMerge(scratch, 7, { ...state, crossRepository: true })).rejects.toThrow("not ones the runner pushes to");
    await expect(github.startMerge(scratch, 7, { ...state, headRef: "--upload-pack=x" })).rejects.toThrow("not ones the runner pushes to");
  });
});
