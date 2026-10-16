// Adapted from agent-office (MIT, Copyright (c) 2026 AgentSystemLabs): src/shared/prompts.ts. See THIRD_PARTY_NOTICES.md.
/**
 * The first prompt an agent gets for an issue.
 *
 * It is built from the issue's number and title alone: the agent reads the
 * issue itself with the GitHub CLI, so nothing of the issue's body passes
 * through the runner. The CEO's note goes last, quoted, as context rather than
 * as instructions in the runner's own voice.
 */

import type { AgentTask } from "./types.js";

export function startPrompt(task: Pick<AgentTask, "issueNumber" | "title" | "note">): string {
  const { issueNumber, title } = task;
  const lines = [
    `Work on GitHub issue #${issueNumber}: "${title}".`,
    "",
    // Without a terminal, `--comments` prints the comments alone, so the issue itself is read separately.
    `Read it first with \`gh issue view ${issueNumber}\`, and its discussion with \`gh issue view ${issueNumber} --comments\`. Implement the change, verify it, then commit it.`,
    "",
    "You're in your own git worktree, on a fresh branch made for this task. Commit there; don't push it or open a pull request.",
  ];
  const note = task.note.trim();
  if (note !== "") {
    lines.push("", "The CEO added this note when assigning it:", "", ...note.split(/\r?\n/).map((line) => `> ${line}`.trimEnd()));
  }
  return lines.join("\n");
}
