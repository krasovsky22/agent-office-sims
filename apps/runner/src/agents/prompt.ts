// Adapted from agent-office (MIT, Copyright (c) 2026 AgentSystemLabs): src/shared/prompts.ts. See THIRD_PARTY_NOTICES.md.
/**
 * The prompts a runner's agent gets: its system prompt, from its profile, and
 * the first prompt for an issue.
 *
 * The system prompt is the agent's title and description, as the CEO wrote
 * them in the office or as they default (`@sim/shared`'s `agentProfile.ts`),
 * and its name. Only the CEO writes them, so they are the runner's own words
 * to its agent, not context to be weighed as the issue's are.
 *
 * The first prompt for an issue
 * It is built from the issue's number and title alone: the agent reads the
 * issue itself with the GitHub CLI, so nothing of the issue's body passes
 * through the runner. It ends with the pull request that hands the work in,
 * which closes the issue once a person merges it. The CEO's note goes last,
 * quoted, as context rather than as instructions in the runner's own voice.
 */

import type { AgentProfile } from "@sim/shared";

import type { AgentTask } from "./types.js";

/** An agent's system prompt, appended to its CLI's own: who it is in the office, and what it is for. */
export function systemPrompt(profile: AgentProfile): string {
  const lines = [`In this office your name is ${profile.name} and your title is ${profile.title}.`];
  const description = profile.description.trim();
  if (description !== "") {
    lines.push("", "Your role, as the CEO describes it:", "", description);
  }
  return lines.join("\n");
}

export function startPrompt(task: Pick<AgentTask, "issueNumber" | "title" | "note">): string {
  const { issueNumber, title } = task;
  const lines = [
    `Work on GitHub issue #${issueNumber}: "${title}".`,
    "",
    // Without a terminal, `--comments` prints the comments alone, so the issue itself is read separately.
    `Read it first with \`gh issue view ${issueNumber}\`, and its discussion with \`gh issue view ${issueNumber} --comments\`. Implement the change, verify it, then commit it.`,
    "",
    "You're in your own git worktree, on a branch made for this task. Commit there, and push only this branch.",
    "",
    `When the work is done and committed, push the branch with \`git push -u origin HEAD\` and open a pull request with \`gh pr create\` whose body includes \`Closes #${issueNumber}\`. Never merge it: a person reviews and merges it.`,
  ];
  const note = task.note.trim();
  if (note !== "") {
    lines.push("", "The CEO added this note when assigning it:", "", ...note.split(/\r?\n/).map((line) => `> ${line}`.trimEnd()));
  }
  return lines.join("\n");
}
