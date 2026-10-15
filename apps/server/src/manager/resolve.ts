/**
 * Turning what someone wrote — `ticket-3`, `#39`, "the onboarding email",
 * "Ada", "someone" — into the work and the agents it means.
 *
 * The rule planner reads the CEO's message with these, and the manager reads a
 * model's plan with the same ones before carrying it out, so a model never gets
 * an id it invented acted on: whatever it names has to resolve against the live
 * view, or the assignment is refused with the reason.
 *
 * `#N` is GitHub's: the project board's issue or pull request with that number,
 * falling back to the in-game `ticket-N` only when the board has no such item.
 * The in-game board's own ids are `ticket-N`, which is how the manager writes
 * them in its answers.
 */

import type { AgentView, IssueView, LiveAgentView, OfficeView, PullRequestView, TicketView } from "./officeView.js";

/** A GitHub item, an issue or a pull request, on the project board. */
export type GithubItem =
  | { readonly kind: "issue"; readonly issue: IssueView }
  | { readonly kind: "pull"; readonly pull: PullRequestView };

/** Work the manager can talk about or hand out. */
export type WorkRef = { readonly kind: "ticket"; readonly ticket: TicketView } | GithubItem;

/** Someone the manager can hand work to. */
export type AgentRef =
  | { readonly kind: "agent"; readonly agent: AgentView }
  | { readonly kind: "live"; readonly agent: LiveAgentView };

/** `ticket-3`, `ticket 3`, `ticket #3`. */
const TICKET_ID = /\bticket[-\s]?#?(\d+)\b/gi;
/** `#39`, `issue 39`, `issue #39`, `PR 40`, `PR #40`, `pull request 40`. */
const GITHUB_NUMBER = /(?:\b(issue|pr|pull request|pull)\s*#?|#)(\d+)\b/gi;

/** Words too common to tell one ticket title from another. */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "onto", "that", "this", "fix", "add", "make", "write", "draft",
  "cut", "get", "put", "set", "new", "our", "all", "out", "off", "up",
]);

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 3 && !STOPWORDS.has(word));
}

/** Every adjacent pair of a title's telling words: "login redirect", "redirect loop". */
function titlePairs(title: string): string[] {
  const telling = words(title);
  const pairs: string[] = [];
  for (let index = 0; index + 1 < telling.length; index += 1) {
    pairs.push(`${telling[index]} ${telling[index + 1]}`);
  }
  return pairs;
}

function ticketById(view: OfficeView, number: string): TicketView | undefined {
  return view.tickets.find((ticket) => ticket.id === `ticket-${Number(number)}`);
}

function githubItem(view: OfficeView, number: number, wanted: "issue" | "pull" | undefined): GithubItem | undefined {
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
  if (a.kind === "ticket" && b.kind === "ticket") {
    return a.ticket.id === b.ticket.id;
  }
  if (a.kind === "issue" && b.kind === "issue") {
    return a.issue.number === b.issue.number;
  }
  if (a.kind === "pull" && b.kind === "pull") {
    return a.pull.number === b.pull.number;
  }
  return false;
}

/**
 * Every piece of work a message mentions, in the order it mentions them.
 *
 * By id first — `ticket-3`, `#39`, `PR 40` — then by title, for a ticket whose
 * title shares two adjacent telling words with the message, which is how
 * someone who has only read the board names a card.
 */
export function findWork(message: string, view: OfficeView): WorkRef[] {
  const found: { readonly at: number; readonly ref: WorkRef }[] = [];
  const add = (at: number, ref: WorkRef | undefined) => {
    if (ref !== undefined && !found.some((entry) => sameRef(entry.ref, ref))) {
      found.push({ at, ref });
    }
  };

  const ticketSpans: [number, number][] = [];
  for (const match of message.matchAll(TICKET_ID)) {
    const ticket = ticketById(view, match[1] ?? "");
    ticketSpans.push([match.index, match.index + match[0].length]);
    add(match.index, ticket === undefined ? undefined : { kind: "ticket", ticket });
  }
  for (const match of message.matchAll(GITHUB_NUMBER)) {
    // `ticket #3` is a ticket, already read above.
    if (ticketSpans.some(([start, end]) => match.index >= start && match.index < end)) {
      continue;
    }
    const prefix = match[1]?.toLowerCase();
    const wanted = prefix === undefined ? undefined : prefix === "issue" ? "issue" : "pull";
    const number = Number(match[2]);
    const item = githubItem(view, number, wanted);
    if (item !== undefined) {
      add(match.index, item);
    } else if (wanted === undefined) {
      const ticket = ticketById(view, String(number));
      add(match.index, ticket === undefined ? undefined : { kind: "ticket", ticket });
    }
  }

  const said = ` ${words(message).join(" ")} `;
  for (const ticket of view.tickets) {
    const pair = titlePairs(ticket.title).find((candidate) => said.includes(` ${candidate} `));
    if (pair !== undefined) {
      add(message.length + said.indexOf(pair), { kind: "ticket", ticket });
    }
  }
  return found.sort((a, b) => a.at - b.at).map((entry) => entry.ref);
}

/**
 * The references a message makes by id or number that name nothing on either
 * board, as written: `#999`, `ticket-42`. So "status of #999" can be told it
 * does not exist rather than answered about something else.
 */
export function findUnknownWork(message: string, view: OfficeView): string[] {
  const unknown: string[] = [];
  const ticketSpans: [number, number][] = [];
  for (const match of message.matchAll(TICKET_ID)) {
    ticketSpans.push([match.index, match.index + match[0].length]);
    if (ticketById(view, match[1] ?? "") === undefined) {
      unknown.push(`ticket-${Number(match[1])}`);
    }
  }
  for (const match of message.matchAll(GITHUB_NUMBER)) {
    if (ticketSpans.some(([start, end]) => match.index >= start && match.index < end)) {
      continue;
    }
    const prefix = match[1]?.toLowerCase();
    const wanted = prefix === undefined ? undefined : prefix === "issue" ? "issue" : "pull";
    const number = Number(match[2]);
    if (githubItem(view, number, wanted) === undefined && (wanted !== undefined || ticketById(view, String(number)) === undefined)) {
      unknown.push(wanted === "pull" ? `PR #${number}` : `#${number}`);
    }
  }
  return unknown;
}

/**
 * The work one reference names, as a planner wrote it: an id, a number, or a
 * ticket's title. `undefined` when it names nothing on either board.
 */
export function resolveWork(reference: string, view: OfficeView): WorkRef | undefined {
  const trimmed = reference.trim();
  const exact = view.tickets.find(
    (ticket) => ticket.id === trimmed || ticket.title.toLowerCase() === trimmed.toLowerCase(),
  );
  if (exact !== undefined) {
    return { kind: "ticket", ticket: exact };
  }
  if (/^\d+$/.test(trimmed)) {
    const number = Number(trimmed);
    const item = githubItem(view, number, undefined);
    const ticket = ticketById(view, trimmed);
    return item ?? (ticket === undefined ? undefined : { kind: "ticket", ticket });
  }
  return findWork(trimmed, view)[0];
}

/** Every agent, simulated and live, by name, id, or first name. */
function agentsOf(view: OfficeView): AgentRef[] {
  return [
    ...view.agents.map((agent): AgentRef => ({ kind: "agent", agent })),
    ...view.liveAgents.map((agent): AgentRef => ({ kind: "live", agent })),
  ];
}

function namesOf(ref: AgentRef): string[] {
  const name = ref.agent.name.toLowerCase();
  return [name, ref.agent.id.toLowerCase(), name.split(" ")[0] ?? name];
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The agent one name means, as a planner wrote it, or `undefined`. */
export function resolveAgent(name: string, view: OfficeView): AgentRef | undefined {
  const wanted = name.trim().toLowerCase();
  if (wanted === "") {
    return undefined;
  }
  return agentsOf(view).find((ref) => namesOf(ref).includes(wanted));
}

/** Every agent a message names, as a whole word, in the order it names them. */
export function findAgents(message: string, view: OfficeView): AgentRef[] {
  const lower = message.toLowerCase();
  const found: { readonly at: number; readonly ref: AgentRef }[] = [];
  for (const ref of agentsOf(view)) {
    let at = Number.POSITIVE_INFINITY;
    for (const candidate of namesOf(ref)) {
      const match = new RegExp(`(^|[^a-z0-9])${escape(candidate)}($|[^a-z0-9])`).exec(lower);
      if (match !== null) {
        at = Math.min(at, match.index);
      }
    }
    if (Number.isFinite(at)) {
      found.push({ at, ref });
    }
  }
  return found.sort((a, b) => a.at - b.at).map((entry) => entry.ref);
}

/** How the manager writes a piece of work: `ticket-3 “Title”`, `#39 “Title”`, `PR #40 “Title”`. */
export function describeWork(ref: WorkRef): string {
  switch (ref.kind) {
    case "ticket":
      return `${ref.ticket.id} “${ref.ticket.title}”`;
    case "issue":
      return `#${ref.issue.number} “${ref.issue.title}”`;
    case "pull":
      return `PR #${ref.pull.number} “${ref.pull.title}”`;
  }
}
