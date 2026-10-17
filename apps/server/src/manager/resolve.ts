/**
 * Turning what someone wrote — `#39`, `PR 40`, "the lighting cycle", "Ada",
 * "someone" — into the work and the agents it means.
 *
 * The rule planner reads the CEO's message with these, and the manager reads a
 * model's plan with the same ones before carrying it out, so a model never gets
 * a number it invented acted on: whatever it names has to resolve against the
 * live view, or the assignment is refused with the reason.
 *
 * All the work there is lives on the project board, so every reference is
 * GitHub's: `#N` is the issue or pull request with that number, `issue N` and
 * `PR N` say which, and an issue can also be named by its title.
 */

import type { IssueAgentView, IssueView, LiveAgentView, OfficeView, PullRequestView } from "./officeView.js";

/** Work the manager can talk about or hand out: an issue or a pull request on the project board. */
export type WorkRef =
  | { readonly kind: "issue"; readonly issue: IssueView }
  | { readonly kind: "pull"; readonly pull: PullRequestView };

/** `#39`, `issue 39`, `issue #39`, `PR 40`, `PR #40`, `pull request 40`. */
const GITHUB_NUMBER = /(?:\b(issue|pr|pull request|pull)\s*#?|#)(\d+)\b/gi;

/** Words too common to tell one issue title from another. */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "onto", "that", "this", "fix", "add", "make", "write", "draft",
  "cut", "get", "put", "set", "new", "our", "all", "out", "off", "up",
]);

/** What people call an issue, around the words that say which one: "the jumping ticket". */
const ISSUE_NOUNS = new Set(["issue", "issues", "ticket", "tickets", "card", "task", "one"]);

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 3 && !STOPWORDS.has(word));
}

/** Every adjacent pair of a title's telling words: "lighting cycle", "night lighting". */
function titlePairs(title: string): string[] {
  const telling = words(title);
  const pairs: string[] = [];
  for (let index = 0; index + 1 < telling.length; index += 1) {
    pairs.push(`${telling[index]} ${telling[index + 1]}`);
  }
  return pairs;
}

function githubItem(view: OfficeView, number: number, wanted: "issue" | "pull" | undefined): WorkRef | undefined {
  const project = view.project;
  if (project === undefined) {
    return undefined;
  }
  if (wanted !== "pull") {
    const issue = project.issues.find((candidate) => candidate.number === number);
    if (issue !== undefined) {
      return { kind: "issue", issue };
    }
  }
  if (wanted !== "issue") {
    const pull = project.pullRequests.find((candidate) => candidate.number === number);
    if (pull !== undefined) {
      return { kind: "pull", pull };
    }
  }
  return undefined;
}

function sameRef(a: WorkRef, b: WorkRef): boolean {
  if (a.kind === "issue" && b.kind === "issue") {
    return a.issue.number === b.issue.number;
  }
  if (a.kind === "pull" && b.kind === "pull") {
    return a.pull.number === b.pull.number;
  }
  return false;
}

/** What a number reference's prefix asks for: `issue`, a pull request, or either. */
function wantedBy(prefix: string | undefined): "issue" | "pull" | undefined {
  const lower = prefix?.toLowerCase();
  return lower === undefined ? undefined : lower === "issue" ? "issue" : "pull";
}

/**
 * Every piece of work a message mentions, in the order it mentions them.
 *
 * By number first — `#39`, `PR 40` — then by title, for an issue whose title
 * shares two adjacent telling words with the message, which is how someone
 * who has only read the board names a card.
 */
export function findWork(message: string, view: OfficeView): WorkRef[] {
  const found: { readonly at: number; readonly ref: WorkRef }[] = [];
  const add = (at: number, ref: WorkRef | undefined) => {
    if (ref !== undefined && !found.some((entry) => sameRef(entry.ref, ref))) {
      found.push({ at, ref });
    }
  };

  for (const match of message.matchAll(GITHUB_NUMBER)) {
    add(match.index, githubItem(view, Number(match[2]), wantedBy(match[1])));
  }

  const said = ` ${words(message).join(" ")} `;
  for (const issue of view.project?.issues ?? []) {
    const pair = titlePairs(issue.title).find((candidate) => said.includes(` ${candidate} `));
    if (pair !== undefined) {
      add(message.length + said.indexOf(pair), { kind: "issue", issue });
    }
  }
  return found.sort((a, b) => a.at - b.at).map((entry) => entry.ref);
}

/** One of a title's words, or one it starts with or that starts it: "jump" and "jumping". */
function sameWord(said: string, title: string): boolean {
  const [short, long] = said.length <= title.length ? [said, title] : [title, said];
  return short === long || (short.length >= 4 && long.startsWith(short));
}

/**
 * The one open issue these words name by its title, when every telling word
 * of them is in its title and in no other open issue's: "jumping ticket" for
 * "Player jumping". `undefined` when they name none, or more than one, so a
 * loose name is only acted on when it is certain.
 */
export function findIssueByTitle(text: string, view: OfficeView): IssueView | undefined {
  const said = words(text).filter((word) => !ISSUE_NOUNS.has(word));
  if (said.length === 0) {
    return undefined;
  }
  const matches = (view.project?.issues ?? []).filter((issue) => {
    const title = words(issue.title);
    return issue.column !== "closed" && said.every((word) => title.some((candidate) => sameWord(word, candidate)));
  });
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The references a message makes by number that name nothing on the project
 * board, as written: `#999`, `PR #42`. So "status of #999" can be told it does
 * not exist rather than answered about something else.
 */
export function findUnknownWork(message: string, view: OfficeView): string[] {
  const unknown: string[] = [];
  for (const match of message.matchAll(GITHUB_NUMBER)) {
    const wanted = wantedBy(match[1]);
    const number = Number(match[2]);
    if (githubItem(view, number, wanted) === undefined) {
      unknown.push(wanted === "pull" ? `PR #${number}` : `#${number}`);
    }
  }
  return unknown;
}

/**
 * The work one reference names, as a planner wrote it: a number, `#N`,
 * `PR #N`, an issue's title, or words only one open issue's title has. `undefined` when it names nothing on the
 * project board.
 */
export function resolveWork(reference: string, view: OfficeView): WorkRef | undefined {
  const trimmed = reference.trim();
  if (/^\d+$/.test(trimmed)) {
    return githubItem(view, Number(trimmed), undefined);
  }
  const titled = view.project?.issues.find((issue) => issue.title.toLowerCase() === trimmed.toLowerCase());
  if (titled !== undefined) {
    return { kind: "issue", issue: titled };
  }
  const found = findWork(trimmed, view)[0];
  if (found !== undefined) {
    return found;
  }
  const loose = findIssueByTitle(trimmed, view);
  return loose === undefined ? undefined : { kind: "issue", issue: loose };
}

/** An agent's name, id, and first name when no other agent shares it, any of which names it. */
function namesOf(agent: IssueAgentView | LiveAgentView, view: OfficeView): string[] {
  const first = (name: string) => name.toLowerCase().split(" ")[0] ?? "";
  const shared = [...view.issueAgents, ...view.liveAgents].some(
    (other) => other !== agent && first(other.name) === first(agent.name),
  );
  const name = agent.name.toLowerCase();
  return shared ? [name, agent.id.toLowerCase()] : [name, agent.id.toLowerCase(), first(agent.name)];
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The agent one name means, as a planner wrote it, or `undefined`: one that
 * takes issues on the floor before one of the orchestrator's.
 */
export function resolveAgent(name: string, view: OfficeView): IssueAgentView | LiveAgentView | undefined {
  const wanted = name.trim().toLowerCase();
  if (wanted === "") {
    return undefined;
  }
  const named = (agent: IssueAgentView | LiveAgentView) => namesOf(agent, view).includes(wanted);
  return view.issueAgents.find(named) ?? view.liveAgents.find(named);
}

/** Every agent a message names, as a whole word, in the order it names them. */
export function findAgents(message: string, view: OfficeView): (IssueAgentView | LiveAgentView)[] {
  const lower = message.toLowerCase();
  const found: { readonly at: number; readonly agent: IssueAgentView | LiveAgentView }[] = [];
  for (const agent of [...view.issueAgents, ...view.liveAgents]) {
    let at = Number.POSITIVE_INFINITY;
    for (const candidate of namesOf(agent, view)) {
      const match = new RegExp(`(^|[^a-z0-9])${escape(candidate)}($|[^a-z0-9])`).exec(lower);
      if (match !== null) {
        at = Math.min(at, match.index);
      }
    }
    if (Number.isFinite(at)) {
      found.push({ at, agent });
    }
  }
  return found.sort((a, b) => a.at - b.at).map((entry) => entry.agent);
}

/** How the manager writes a piece of work: `#39 “Title”`, `PR #40 “Title”`. */
export function describeWork(ref: WorkRef): string {
  switch (ref.kind) {
    case "issue":
      return `#${ref.issue.number} “${ref.issue.title}”`;
    case "pull":
      return `PR #${ref.pull.number} “${ref.pull.title}”`;
  }
}
