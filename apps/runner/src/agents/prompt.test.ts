/**
 * The first prompt names the issue by number and title, and quotes the CEO's
 * note rather than speaking it. The system prompt is the agent's profile.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_AGENT_DESCRIPTION, DEFAULT_AGENT_TITLE } from "@sim/shared";

import { startPrompt, systemPrompt } from "./prompt.js";

describe("systemPrompt", () => {
  it("names the agent and its title, then gives its description as the CEO's", () => {
    expect(systemPrompt({ name: "Maya", title: DEFAULT_AGENT_TITLE, description: DEFAULT_AGENT_DESCRIPTION })).toBe(
      [
        "In this office your name is Maya and your title is Software Developer.",
        "",
        "Your role, as the CEO describes it:",
        "",
        DEFAULT_AGENT_DESCRIPTION,
      ].join("\n"),
    );
  });

  it("leaves the description out when there is none", () => {
    expect(systemPrompt({ name: "Leo", title: "QA Engineer", description: "" })).toBe(
      "In this office your name is Leo and your title is QA Engineer.",
    );
  });
});

describe("startPrompt", () => {
  it("names the issue, how to read it, and the pull request that hands it in", () => {
    const prompt = startPrompt({ issueNumber: 39, title: "Fix the lift", note: "" });
    expect(prompt).toBe(
      [
        'Work on GitHub issue #39: "Fix the lift".',
        "",
        "Read it first with `gh issue view 39`, and its discussion with `gh issue view 39 --comments`. Implement the change, verify it, then commit it.",
        "",
        "You're in your own git worktree, on a branch made for this task. Commit there, and push only this branch.",
        "",
        "When the work is done and committed, push the branch with `git push -u origin HEAD` and open a pull request with `gh pr create` whose body includes `Closes #39`. Never merge it: a person reviews and merges it.",
      ].join("\n"),
    );
  });

  it("appends the CEO's note quoted, line by line", () => {
    const prompt = startPrompt({ issueNumber: 39, title: "Fix the lift", note: "Start with the doors.\n\nIgnore the stairs." });
    expect(prompt.endsWith("The CEO added this note when assigning it:\n\n> Start with the doors.\n>\n> Ignore the stairs.")).toBe(true);
  });
});
