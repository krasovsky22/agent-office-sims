/**
 * What an agent's terminal panel links to: the issue it is working on and any
 * pull request it has opened for it.
 *
 * No one record says both. The agent's own task names the issue, the office's
 * work on that issue holds the pull request the agent handed in as its
 * deliverable, and the project board lists the open pull requests that say
 * they close the issue. This reads all three, so the panel can link whatever
 * is known so far.
 *
 * A deliverable is text an agent wrote, so a URL found in it is only linked
 * once it has passed the same `https:` check a task's URL does and names a
 * pull request on GitHub. The mock agent's simulated pull request has nothing
 * on GitHub to link, so the panel says it is one instead.
 */

import {
  type ProjectBoardSnapshot,
  WORK_STATUS,
  type WorkData,
  isSimulatedPullRequestArtifact,
  parseTaskUrl,
  taskReference,
} from "@sim/shared";

import { boardIssue, githubItemUrl } from "./projectBoard.js";

/** One link in the panel: `#12` or `PR #40`, and where it goes. */
export interface TerminalLink {
  readonly label: string;
  readonly href: string;
}

export interface TerminalLinks {
  readonly issue: TerminalLink | undefined;
  readonly pullRequests: readonly TerminalLink[];
  /** The agent handed its work in as a simulated pull request: shown as one, never linked. */
  readonly simulatedPullRequest: boolean;
}

/** No links: a desk's computer works on no issue. */
export const NO_LINKS: TerminalLinks = { issue: undefined, pullRequests: [], simulatedPullRequest: false };

/** Anything that looks like a URL in free text; {@link parseTaskUrl} decides whether it is one. */
const URL_IN_TEXT = /https:\/\/[^\s<>"']+/g;

/** Punctuation that ends a sentence rather than a URL. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/;

/** A GitHub issue or pull request link, or `undefined` for any other text. */
function githubLink(raw: string, kind: "issue" | "pull"): TerminalLink | undefined {
  const href = parseTaskUrl(raw);
  if (href === undefined || href === "") {
    return undefined;
  }
  const label = taskReference(href);
  const isPull = label.startsWith("PR #");
  if (label === "" || isPull !== (kind === "pull")) {
    return undefined;
  }
  return { label, href };
}

/**
 * The links for the agent `agentId`, whose task URL is `taskUrl`.
 *
 * @param work the office's work, in which the agent's is the one assigned to it.
 * @param snapshot the project board, for the repository and its linked pull requests.
 */
export function terminalLinks(
  agentId: string,
  taskUrl: string,
  work: readonly WorkData[],
  snapshot: ProjectBoardSnapshot | undefined,
): TerminalLinks {
  const pullRequests: TerminalLink[] = [];
  const addPull = (link: TerminalLink | undefined) => {
    if (link !== undefined && !pullRequests.some((existing) => existing.href === link.href)) {
      pullRequests.push(link);
    }
  };

  let issue = githubLink(taskUrl, "issue");
  // A task can be a pull request rather than an issue.
  addPull(githubLink(taskUrl, "pull"));

  const issueNumber = issue === undefined ? undefined : Number(issue.label.slice(1));
  const mine = work.filter((entry) => entry.assigneeId === agentId);
  // Handed-in work stays with the agent after it moves on, so only open work stands in for an unnamed task.
  const current =
    issueNumber === undefined
      ? mine.find((entry) => entry.status === WORK_STATUS.assigned || entry.status === WORK_STATUS.in_progress)
      : mine.find((entry) => entry.issueNumber === issueNumber);

  const simulatedPullRequest = current !== undefined && isSimulatedPullRequestArtifact(current.outputArtifact);
  if (current !== undefined) {
    if (issue === undefined && snapshot !== undefined) {
      const href = githubItemUrl(snapshot.repository, "issues", current.issueNumber);
      issue = href === null ? undefined : { label: `#${current.issueNumber}`, href };
    }
    for (const match of current.outputArtifact.matchAll(URL_IN_TEXT)) {
      addPull(githubLink(match[0].replace(TRAILING_PUNCTUATION, ""), "pull"));
    }
  }

  // Only for an issue in the board's own repository, whose numbers the board's are.
  const boardNumber = issue === undefined ? undefined : Number(issue.label.slice(1));
  if (
    snapshot !== undefined &&
    boardNumber !== undefined &&
    githubItemUrl(snapshot.repository, "issues", boardNumber) === issue?.href
  ) {
    for (const pull of boardIssue(snapshot, boardNumber)?.pullRequests ?? []) {
      const href = githubItemUrl(snapshot.repository, "pull", pull);
      if (href !== null) {
        addPull({ label: `PR #${pull}`, href });
      }
    }
  }

  return { issue, pullRequests, simulatedPullRequest };
}
