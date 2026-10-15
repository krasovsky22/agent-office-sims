/**
 * The AI manager without a model: answers built by rule from the live office.
 *
 * This is the default (`MOCK_MANAGER`, see `../config.ts`), so the manager can
 * be built and demonstrated without spending anything, and it makes no network
 * call. It is also the fallback when a configured model fails, so a CEO asking
 * for status still gets one. What it understands is the handful of things a
 * CEO asks a manager most:
 *
 * - **"Put Ada on ticket-3"**, "put someone on #39", "hand out the backlog":
 *   an instruction in one of a few exact shapes becomes a plan to assign —
 *   carried out afterwards through the board's rules, like a model's plan. One
 *   that starts like an instruction and is not exactly one of them is not
 *   guessed at: nothing is done, and the CEO is asked to rephrase.
 * - **"What's the status of #12?"**: any work it can find in the message is
 *   described — a ticket's column and assignee, an issue's column, labels and
 *   pull requests, and which agent is on it.
 * - **"What is Ada doing?"**: a named agent is described.
 * - **"What is everyone working on?"**, "how's the board?", "any PRs?": a
 *   summary of the agents, the ticket board, or the project board.
 *
 * Anything else gets a short list of what it can do. Every word of every
 * answer comes from the {@link OfficeView} it is handed.
 */

import { AGENT_ACTIVITY, TICKET_PRIORITY, TICKET_STATUS, TICKET_STATUSES, type TicketStatus } from "@sim/shared";

import type { ManagerPlan, ManagerRequest } from "./advisor.js";
import type { AgentView, IssueView, LiveAgentView, OfficeView, PullRequestView, TicketView } from "./officeView.js";
import {
  type AgentRef,
  type WorkRef,
  describeWork,
  findAgents,
  findUnknownWork,
  findWork,
  resolveAgent,
} from "./resolve.js";

/** Most items one list in an answer names before saying how many more there are. */
const LIST_LIMIT = 8;

/** "please", "can you", "firstmate," and the like ahead of an instruction. */
const LEAD_IN = /^(?:(?:please|ok(?:ay)?|(?:can|could|would|will) you|firstmate)[\s,]+)*/;
/** A question is answered and never acted on: it is told by how it starts. */
const QUESTION_START =
  /^(what|what's|whats|how|how's|hows|who|who's|which|where|why|when|is|are|was|were|do|does|did|has|had|should|any|status|have you)\b/;
/** Words that can close an instruction without changing it. */
const FILLER = /^(please|now|today|asap|thanks)$/;
/** A message starting with one of these is an instruction, or an attempt at one. */
const INSTRUCTION_VERBS: ReadonlySet<string> = new Set(["put", "assign", "reassign", "give", "hand", "move", "send", "have", "distribute"]);
/** "give me…", "send us…": asking for something, not handing work out. */
const NOT_AN_AGENT = /^(me|us|you|myself)$/;
/** VERB AGENT (on|onto|to) WORK: "put Bo on ticket-1". */
const AGENT_FIRST_VERBS: ReadonlySet<string> = new Set(["put", "assign", "reassign", "give", "hand", "move"]);
const AGENT_FIRST_LINKS: ReadonlySet<string> = new Set(["on", "onto", "to"]);
/** VERB WORK to AGENT [and WORK to AGENT]*: "give ticket-1 to Bo and ticket-5 to Ada". */
const WORK_FIRST_VERBS: ReadonlySet<string> = new Set(["assign", "reassign", "give", "hand", "send"]);
/** have AGENT TAKE WORK: "have someone take #39". */
const TAKE_VERBS: readonly string[] = ["take", "pick up", "do", "handle", "work on", "start on"];
/** VERB the backlog [to AGENT]: "hand out the backlog". */
const BACKLOG_VERBS: readonly string[] = ["hand out", "give out", "assign", "distribute"];
const ANYONE = /^(someone|anyone|whoever)$/;
/** The one clause an AGENT may carry: "someone who's free". */
const AGENT_CLAUSES: readonly string[] = ["who's free", "who is free", "who's idle", "who is idle"];
/** What may sit between work references in the WORK slot. */
const WORK_CONNECTORS: ReadonlySet<string> = new Set(["the", "and", ",", "#"]);
const NUMBER = /^#?\d+$/;

export const REPHRASE_TEXT =
  "I couldn't tell exactly what to hand out, so I haven't changed anything. Say it like “assign ticket-3 to Ada” or “put someone on #39”.";

/** "who should I give #39 to?" asks for advice rather than an assignment. */
const ASKING_ADVICE = /\b(should i|who should|who would|who could|who can)\b/i;
const GREETING = /^\s*(hi|hello|hey|morning|good (morning|afternoon|evening)|help|\?)\b/i;
const BOARD_WORDS = /\b(board|tickets?|backlog|review|queue|blocked|stuck|done|approve)\b/i;
const PROJECT_WORDS = /\b(issues?|prs?|pull requests?|github|repo|repository|checks?|ci)\b/i;
const TEAM_WORDS =
  /\b(everyone|everybody|team|agents?|staff|people|crew|who|working|doing|busy|free|idle|status|update|progress|how)\b/i;

const COLUMN_TEXT: Readonly<Record<TicketStatus, string>> = {
  [TICKET_STATUS.backlog]: "in the backlog",
  [TICKET_STATUS.assigned]: "assigned",
  [TICKET_STATUS.in_progress]: "in progress",
  [TICKET_STATUS.review]: "waiting for your review",
  [TICKET_STATUS.done]: "done",
};

const ACTIVITY_TEXT: Readonly<Record<AgentView["activity"], string>> = {
  [AGENT_ACTIVITY.idle]: "idle",
  [AGENT_ACTIVITY.walking]: "on the move",
  [AGENT_ACTIVITY.working]: "working",
  [AGENT_ACTIVITY.meeting]: "in a meeting",
  [AGENT_ACTIVITY.blocked]: "stuck",
};

export const HELP_TEXT = [
  "I keep track of the agents and hand out the work. Ask me things like:",
  "- “What is everyone working on?”",
  "- “What's the status of ticket-3?” or “…of #12?”",
  "- “Put Ada on ticket-2” or “Put someone on #39”",
  "- “Hand out the backlog”",
].join("\n");

/** One planner attempt: never throws, never waits. */
export function planFromRules(request: ManagerRequest): ManagerPlan {
  return { ...answer(request.message, request.view), tokensUsed: 0 };
}

function answer(message: string, view: OfficeView): Omit<ManagerPlan, "tokensUsed"> {
  const work = findWork(message, view);
  const agents = findAgents(message, view);

  const instruction = readInstruction(message, view);
  if (instruction?.kind === "unclear") {
    return { reply: REPHRASE_TEXT, assignments: [] };
  }
  if (instruction?.kind === "backlog") {
    const backlog = view.tickets.filter((ticket) => ticket.status === TICKET_STATUS.backlog);
    if (backlog.length === 0) {
      return { reply: "The backlog is empty, so there is nothing to hand out.", assignments: [] };
    }
    return {
      reply: "Handing out the backlog:",
      assignments: backlog.map((ticket) => ({ work: ticket.id, agent: instruction.agent?.agent.id ?? "" })),
    };
  }
  if (instruction?.kind === "work") {
    const unknown = instruction.pairs.flatMap((entry) => entry.slot.unknown);
    if (unknown.length > 0) {
      return { reply: cannotFind(unknown, view), assignments: [] };
    }
    return {
      reply: "Here's how that went:",
      assignments: instruction.pairs.flatMap((entry) =>
        entry.slot.work.map((ref) => ({ work: workId(ref), agent: entry.agent?.agent.id ?? "" })),
      ),
    };
  }

  const unknown = findUnknownWork(message, view);
  if (work.length === 0 && unknown.length > 0) {
    return { reply: cannotFind(unknown, view), assignments: [] };
  }

  if (work.length > 0) {
    const lines = work.slice(0, LIST_LIMIT).map((ref) => describeRef(ref, view));
    if (ASKING_ADVICE.test(message)) {
      lines.push(adviceFor(work, view));
    }
    return { reply: lines.join("\n"), assignments: [] };
  }
  if (agents.length > 0) {
    return { reply: agents.slice(0, LIST_LIMIT).map((ref) => describeAgentRef(ref, view)).join("\n"), assignments: [] };
  }
  if (PROJECT_WORDS.test(message)) {
    return { reply: projectSummary(view), assignments: [] };
  }
  if (BOARD_WORDS.test(message)) {
    return { reply: boardSummary(view), assignments: [] };
  }
  if (TEAM_WORDS.test(message)) {
    return { reply: teamSummary(view), assignments: [] };
  }
  if (GREETING.test(message)) {
    return { reply: `Hello${view.ceo === undefined ? "" : `, ${view.ceo}`}. ${HELP_TEXT}`, assignments: [] };
  }
  return { reply: `I didn't catch what you want me to look at. ${HELP_TEXT}`, assignments: [] };
}

/** `undefined` for "someone": whoever is free, chosen against the live office. */
type Assignee = AgentRef | undefined;

/** Work read from a WORK slot: what it names, and what it names that is on neither board. */
interface WorkSlot {
  readonly work: readonly WorkRef[];
  readonly unknown: readonly string[];
}

type Instruction =
  | { readonly kind: "work"; readonly pairs: readonly { readonly slot: WorkSlot; readonly agent: Assignee }[] }
  | { readonly kind: "backlog"; readonly agent: Assignee }
  /** It starts like an instruction but is not exactly one of its shapes: nothing is done. */
  | { readonly kind: "unclear" };

/** The message as words: lower case, the lead-in, a trailing "?" and closing filler gone. */
function wordsOf(message: string): string[] {
  const lower = message.toLowerCase().replace(/’/g, "'").trim();
  const words = lower
    .slice(LEAD_IN.exec(lower)?.[0].length ?? 0)
    .replace(/,/g, " , ")
    .split(/\s+/)
    .map((word) => word.replace(/[.!?;:]+$/, ""))
    .filter((word) => word !== "");
  while (words.length > 0 && FILLER.test(words[words.length - 1] ?? "")) {
    words.pop();
  }
  return words;
}

function startsWith(words: readonly string[], phrase: string): boolean {
  const parts = phrase.split(" ");
  return parts.every((part, index) => words[index] === part);
}

/**
 * The AGENT slot, when these words are exactly one: an agent's name, first
 * name or id, or someone/anyone/whoever, with at most one "who's free"-style
 * clause. `null` when they are not.
 */
function readAgent(words: readonly string[], view: OfficeView): { readonly agent: Assignee } | null {
  for (const clause of ["", ...AGENT_CLAUSES]) {
    const clauseWords = clause === "" ? [] : clause.split(" ");
    const tail = words.slice(words.length - clauseWords.length);
    if (clauseWords.length > words.length || tail.join(" ") !== clauseWords.join(" ")) {
      continue;
    }
    const name = words.slice(0, words.length - clauseWords.length).join(" ");
    if (ANYONE.test(name)) {
      return { agent: undefined };
    }
    if (clause !== "" || name === "" || NOT_AN_AGENT.test(name)) {
      continue;
    }
    const agent = resolveAgent(name, view);
    if (agent !== undefined) {
      return { agent };
    }
  }
  return null;
}

/**
 * The WORK slot, when these words are exactly one: work references joined by
 * "the", "and", commas and possessives such as "Bo's", or exactly one
 * ticket's full title. `null` when they are not.
 */
function readWork(words: readonly string[], view: OfficeView): WorkSlot | null {
  const plain = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const said = plain(words.join(" "));
  const titled = view.tickets.find((ticket) => said !== "" && plain(ticket.title) === said);
  if (titled !== undefined) {
    return { work: [{ kind: "ticket", ticket: titled }], unknown: [] };
  }

  const references: string[] = [];
  for (let at = 0; at < words.length; at += 1) {
    const word = words[at] ?? "";
    const next = words[at + 1] ?? "";
    if (/^ticket-#?\d+$/.test(word) || /^#\d+$/.test(word)) {
      references.push(word);
    } else if ((word === "ticket" || word === "issue" || word === "pr") && NUMBER.test(next)) {
      references.push(`${word} ${next}`);
      at += 1;
    } else if (WORK_CONNECTORS.has(word)) {
      continue;
    } else if (!(word.endsWith("'s") && resolveAgent(word.slice(0, -2), view) !== undefined)) {
      return null;
    }
  }
  if (references.length === 0) {
    return null;
  }
  const work: WorkRef[] = [];
  const unknown: string[] = [];
  for (const reference of references) {
    const found = findWork(reference, view)[0];
    if (found === undefined) {
      unknown.push(...findUnknownWork(reference, view));
    } else {
      work.push(found);
    }
  }
  return { work, unknown };
}

/** VERB WORK to AGENT [and WORK to AGENT]*, every way the words can split, first that fits. */
function readPairs(words: readonly string[], view: OfficeView): { slot: WorkSlot; agent: Assignee }[] | null {
  for (let to = 1; to < words.length; to += 1) {
    if (words[to] !== "to") {
      continue;
    }
    const slot = readWork(words.slice(0, to), view);
    if (slot === null) {
      continue;
    }
    const rest = words.slice(to + 1);
    const whole = readAgent(rest, view);
    if (whole !== null) {
      return [{ slot, agent: whole.agent }];
    }
    for (let and = 1; and < rest.length; and += 1) {
      if (rest[and] !== "and") {
        continue;
      }
      const agent = readAgent(rest.slice(0, and), view);
      const more = agent === null ? null : readPairs(rest.slice(and + 1), view);
      if (agent !== null && more !== null) {
        return [{ slot, agent: agent.agent }, ...more];
      }
    }
  }
  return null;
}

/**
 * What a message instructs, by a strict grammar: the whole message, less a
 * lead-in, a trailing "?" and closing filler, must be exactly one of
 *
 * 1. VERB AGENT (on|onto|to) WORK — "put Bo on ticket-1"
 * 2. VERB WORK to AGENT [and WORK to AGENT]* — "give ticket-1 to Bo"
 * 3. have AGENT (take|pick up|do|handle|work on|start on) WORK — "have someone take #39"
 * 4. (hand out|give out|assign|distribute) the backlog [to AGENT]
 *
 * A message that starts like one and is not exactly one is `unclear`, and
 * nothing is acted on. `undefined` for anything else: a question, or a
 * request such as "give me the status of ticket-3".
 */
function readInstruction(message: string, view: OfficeView): Instruction | undefined {
  const words = wordsOf(message);
  const [verb = "", object = ""] = words;
  if (QUESTION_START.test(words.join(" ")) || !INSTRUCTION_VERBS.has(verb) || NOT_AN_AGENT.test(object)) {
    return undefined;
  }

  for (const phrase of BACKLOG_VERBS) {
    const length = phrase.split(" ").length;
    if (!startsWith(words, phrase) || words[length] !== "the" || words[length + 1] !== "backlog") {
      continue;
    }
    const rest = words.slice(length + 2);
    if (rest.length === 0) {
      return { kind: "backlog", agent: undefined };
    }
    const agent = rest[0] === "to" ? readAgent(rest.slice(1), view) : null;
    return agent === null ? { kind: "unclear" } : { kind: "backlog", agent: agent.agent };
  }

  for (let at = 2; at < words.length; at += 1) {
    const agent = () => readAgent(words.slice(1, at), view);
    if (AGENT_FIRST_VERBS.has(verb) && AGENT_FIRST_LINKS.has(words[at] ?? "")) {
      const found = agent();
      const slot = found === null ? null : readWork(words.slice(at + 1), view);
      if (found !== null && slot !== null) {
        return { kind: "work", pairs: [{ slot, agent: found.agent }] };
      }
    }
    if (verb === "have") {
      const take = TAKE_VERBS.find((phrase) => startsWith(words.slice(at), phrase));
      const found = take === undefined ? null : agent();
      const slot = take === undefined || found === null ? null : readWork(words.slice(at + take.split(" ").length), view);
      if (found !== null && slot !== null) {
        return { kind: "work", pairs: [{ slot, agent: found.agent }] };
      }
    }
  }

  const pairs = WORK_FIRST_VERBS.has(verb) ? readPairs(words.slice(1), view) : null;
  return pairs === null ? { kind: "unclear" } : { kind: "work", pairs };
}

function cannotFind(unknown: readonly string[], view: OfficeView): string {
  const where = view.project === undefined ? "the ticket board (and the project board hasn't loaded yet)" : "the ticket board or the project board";
  return `I can't find ${unknown.join(" or ")} on ${where}.`;
}

function workId(ref: WorkRef): string {
  switch (ref.kind) {
    case "ticket":
      return ref.ticket.id;
    case "issue":
      return `issue #${ref.issue.number}`;
    case "pull":
      return `PR #${ref.pull.number}`;
  }
}

function adviceFor(work: readonly WorkRef[], view: OfficeView): string {
  const github = work.some((ref) => ref.kind !== "ticket");
  const free = github
    ? view.liveAgents.filter((agent) => agent.status === "idle" && agent.assigned === undefined).map((agent) => agent.name)
    : view.agents.filter((agent) => agent.activity === AGENT_ACTIVITY.idle && agent.ticketId === undefined).map((agent) => agent.name);
  const first = free[0];
  return first === undefined
    ? "Nobody suitable is free right now; name someone and I'll queue it for them."
    : `${free.join(", ")} ${free.length === 1 ? "is" : "are"} free. Say “put ${first.split(" ")[0] ?? first} on it” and I'll hand it over.`;
}

function describeRef(ref: WorkRef, view: OfficeView): string {
  switch (ref.kind) {
    case "ticket":
      return describeTicket(ref.ticket, view);
    case "issue":
      return describeIssue(ref.issue, view);
    case "pull":
      return describePull(ref.pull, view);
  }
}

function describeTicket(ticket: TicketView, view: OfficeView): string {
  const name = describeWork({ kind: "ticket", ticket });
  const who = ticket.assignee ?? (ticket.assigneeId === "" ? undefined : "someone who has left");
  const urgent = ticket.priority === TICKET_PRIORITY.high ? " High priority." : "";
  const holder = view.agents.find((agent) => agent.id === ticket.assigneeId);
  switch (ticket.status) {
    case TICKET_STATUS.backlog:
      return `${name} is in the backlog, unassigned.${urgent}`;
    case TICKET_STATUS.assigned:
      return `${name} is assigned to ${who ?? "nobody"}, who hasn't started it yet.${urgent}`;
    case TICKET_STATUS.in_progress:
      if (holder?.activity === AGENT_ACTIVITY.blocked) {
        return `${name} is in progress, but ${holder.name} is stuck on it — ${ticket.latestNote ?? "no reason given"}`;
      }
      return `${name} is in progress with ${who ?? "nobody"}.${urgent}`;
    case TICKET_STATUS.review:
      return `${name} is waiting for your review: ${who ?? "its assignee"} handed in a deliverable.`;
    case TICKET_STATUS.done:
      return `${name} is done${who === undefined ? "" : ` — ${who} finished it`}.`;
  }
}

/** Live agents on, or handed, a GitHub item, in words. */
function liveAgentsOn(url: string, view: OfficeView): string {
  const on = view.liveAgents.filter((agent) => agent.task?.url === url).map((agent) => agent.name);
  const next = view.liveAgents.filter((agent) => agent.assigned?.url === url).map((agent) => agent.name);
  const parts: string[] = [];
  if (on.length > 0) {
    parts.push(`${on.join(" and ")} ${on.length === 1 ? "is" : "are"} working on it`);
  }
  if (next.length > 0) {
    parts.push(`it is assigned to ${next.join(" and ")} next`);
  }
  return parts.length === 0 ? "" : ` ${capitalise(parts.join("; "))}.`;
}

function describeIssue(issue: IssueView, view: OfficeView): string {
  const labels = issue.labels.length === 0 ? "" : ` [${issue.labels.join(", ")}]`;
  const assignees = issue.assignees.length === 0 ? "" : `, assigned on GitHub to ${issue.assignees.join(", ")}`;
  const pulls =
    issue.pullRequests.length === 0
      ? ""
      : ` ${issue.pullRequests.map((number) => `PR #${number}`).join(", ")} ${issue.pullRequests.length === 1 ? "closes" : "close"} it.`;
  return `#${issue.number} “${issue.title}” is ${issue.column}${labels}${assignees}.${pulls}${liveAgentsOn(issue.url, view)}${stale(view)}`;
}

function describePull(pull: PullRequestView, view: OfficeView): string {
  const draft = pull.draft ? ", a draft," : "";
  const checks = pull.checks === "unknown" || pull.checks === "none" ? "" : ` Checks are ${pull.checks}.`;
  return `PR #${pull.number} “${pull.title}” by ${pull.author}${draft} is open.${checks}${liveAgentsOn(pull.url, view)}${stale(view)}`;
}

function describeAgent(agent: AgentView, view: OfficeView): string {
  const ticket = view.tickets.find((candidate) => candidate.id === agent.ticketId);
  const title = `${agent.name} (${agent.jobTitle})`;
  if (agent.activity === AGENT_ACTIVITY.blocked && ticket !== undefined) {
    return `${title} is stuck on ${describeWork({ kind: "ticket", ticket })} — ${ticket.latestNote ?? "no reason given"}`;
  }
  if (ticket !== undefined) {
    return `${title} is ${ACTIVITY_TEXT[agent.activity]} on ${describeWork({ kind: "ticket", ticket })}.`;
  }
  const waiting = view.tickets.filter(
    (candidate) => candidate.assigneeId === agent.id && candidate.status === TICKET_STATUS.assigned,
  );
  const queued = waiting.length === 0 ? "" : ` Next up: ${waiting.map((candidate) => candidate.id).join(", ")}.`;
  return `${title} is ${ACTIVITY_TEXT[agent.activity]}.${queued}`;
}

function describeLiveAgent(agent: LiveAgentView): string {
  const doing =
    agent.status === "working"
      ? `working on ${agent.task === undefined ? "something it hasn't named" : linkText(agent.task)}`
      : "idle";
  const next = agent.assigned === undefined ? "" : ` Next up: ${linkText(agent.assigned)}.`;
  return `${agent.name} (live coding agent) is ${doing}.${next}`;
}

function describeAgentRef(ref: AgentRef, view: OfficeView): string {
  return ref.kind === "agent" ? describeAgent(ref.agent, view) : describeLiveAgent(ref.agent);
}

function linkText(link: { readonly title: string; readonly reference: string }): string {
  return link.reference === "" ? `“${link.title}”` : `${link.reference} “${link.title}”`;
}

function teamSummary(view: OfficeView): string {
  if (view.agents.length === 0 && view.liveAgents.length === 0) {
    return "Nobody is on the floor right now: there are no agents to report on.";
  }
  const lines: string[] = [];
  if (view.agents.length > 0) {
    lines.push("Agents:", ...view.agents.map((agent) => `- ${describeAgent(agent, view)}`));
  }
  if (view.liveAgents.length > 0) {
    lines.push("Live coding agents:", ...view.liveAgents.map((agent) => `- ${describeLiveAgent(agent)}`));
  }
  const free = [
    ...view.agents.filter((agent) => agent.activity === AGENT_ACTIVITY.idle && agent.ticketId === undefined),
    ...view.liveAgents.filter((agent) => agent.status === "idle" && agent.assigned === undefined),
  ].map((agent) => agent.name);
  lines.push(free.length === 0 ? "Nobody is free." : `Free for something new: ${free.join(", ")}.`);
  return lines.join("\n");
}

function boardSummary(view: OfficeView): string {
  const count = (status: TicketStatus) => view.tickets.filter((ticket) => ticket.status === status).length;
  const lines = [`The ticket board: ${TICKET_STATUSES.map((status) => `${count(status)} ${COLUMN_TEXT[status]}`).join(", ")}.`];
  const review = view.tickets.filter((ticket) => ticket.status === TICKET_STATUS.review);
  if (review.length > 0) {
    lines.push(`Waiting for your review: ${list(review.map((ticket) => `${ticket.id} (${ticket.assignee ?? "unknown"})`))}.`);
  }
  const stuck = view.agents.filter((agent) => agent.activity === AGENT_ACTIVITY.blocked);
  for (const agent of stuck) {
    lines.push(`- ${describeAgent(agent, view)}`);
  }
  const backlog = view.tickets.filter((ticket) => ticket.status === TICKET_STATUS.backlog);
  if (backlog.length > 0) {
    lines.push(`Unassigned: ${list(backlog.map((ticket) => describeWork({ kind: "ticket", ticket })))}.`);
  }
  return lines.join("\n");
}

function projectSummary(view: OfficeView): string {
  const project = view.project;
  if (project === undefined) {
    return "The project board hasn't loaded from GitHub yet, so I can't say anything about issues or pull requests.";
  }
  const open = project.issues.filter((issue) => issue.column === "open");
  const inProgress = project.issues.filter((issue) => issue.column === "in progress");
  const lines = [
    `${project.repository}: ${open.length} open issues, ${inProgress.length} in progress, ${project.pullRequests.length} open pull requests.${stale(view)}`,
  ];
  if (inProgress.length > 0) {
    lines.push(`In progress: ${list(inProgress.map((issue) => `#${issue.number} “${issue.title}”`))}.`);
  }
  if (project.pullRequests.length > 0) {
    lines.push(
      `Open pull requests: ${list(project.pullRequests.map((pull) => `PR #${pull.number} “${pull.title}”${pull.checks === "failing" ? " (checks failing)" : ""}`))}.`,
    );
  }
  return lines.join("\n");
}

function stale(view: OfficeView): string {
  return view.project?.stale === true ? " (GitHub was unreachable on the last poll, so this may be out of date.)" : "";
}

function list(items: readonly string[]): string {
  const shown = items.slice(0, LIST_LIMIT).join(", ");
  return items.length > LIST_LIMIT ? `${shown} and ${items.length - LIST_LIMIT} more` : shown;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
