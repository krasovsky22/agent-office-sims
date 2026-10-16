/**
 * The AI manager without a model: answers built by rule from the live office.
 *
 * This is the default (`MOCK_MANAGER`, see `../config.ts`), so the manager can
 * be built and demonstrated without spending anything, and it makes no network
 * call. It is also the fallback when a configured model fails, so a CEO asking
 * for status still gets one. Everything it knows about the work comes from
 * the project board the server already polls and the office's own work on its
 * issues. What it understands is the handful of things a CEO asks a manager
 * most:
 *
 * - **"Put Ada on #12"**, "put someone on #39", "hand out the backlog": an
 *   instruction in one of a few exact shapes becomes a plan to assign —
 *   carried out afterwards through the work's rules, like a model's plan. One
 *   that starts like an instruction and is not exactly one of them is not
 *   guessed at: nothing is done, and the CEO is asked to rephrase.
 * - **"What's the status of #12?"**: any issue or pull request it can find in
 *   the message is described — its column, labels and pull requests, and
 *   which agent is on it and how far they have got.
 * - **"What is Ada doing?"**: a named agent is described.
 * - **"What's open?"**, "which PRs are open?", "what is everyone working on?":
 *   a summary of the project board, its pull requests, or the agents.
 *
 * Anything else gets a short list of what it can do. Every word of every
 * answer comes from the {@link OfficeView} it is handed.
 */

import { WORK_STATUS, type WorkStatus } from "@sim/shared";

import type { ManagerPlan, ManagerRequest } from "./advisor.js";
import type { IssueAgentView, IssueView, LiveAgentView, OfficeView, PullRequestView, WorkView } from "./officeView.js";
import { type WorkRef, findAgents, findUnknownWork, findWork, resolveAgent } from "./resolve.js";

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
/** VERB AGENT (on|onto|to) WORK: "put Bo on #12". */
const AGENT_FIRST_VERBS: ReadonlySet<string> = new Set(["put", "assign", "reassign", "give", "hand", "move"]);
const AGENT_FIRST_LINKS: ReadonlySet<string> = new Set(["on", "onto", "to"]);
/** VERB WORK to AGENT [and WORK to AGENT]*: "give #12 to Bo and #15 to Ada". */
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
  "I couldn't tell exactly what to hand out, so I haven't changed anything. Say it like “assign #12 to Ada” or “put someone on #39”.";

/** "who should I give #39 to?" asks for advice rather than an assignment. */
const ASKING_ADVICE = /\b(should i|who should|who would|who could|who can)\b/i;
const GREETING = /^\s*(hi|hello|hey|morning|good (morning|afternoon|evening)|help|\?)\b/i;
const PULL_WORDS = /\b(prs?|pull requests?|checks?|ci)\b/i;
const BOARD_WORDS =
  /\b(board|issues?|tickets?|backlog|open|review|queue|blocked|stuck|done|approve|github|repo|repository|labels?)\b/i;
const TEAM_WORDS =
  /\b(everyone|everybody|team|agents?|staff|people|crew|who|working|doing|busy|free|idle|status|update|progress|how)\b/i;

const WORK_TEXT: Readonly<Record<WorkStatus, string>> = {
  [WORK_STATUS.assigned]: "assigned",
  [WORK_STATUS.in_progress]: "in progress",
  [WORK_STATUS.review]: "waiting for your review",
  [WORK_STATUS.done]: "done",
};

export const HELP_TEXT = [
  "I keep track of the agents and hand out the project board's issues. Ask me things like:",
  "- “What's open?” or “Which PRs are open?”",
  "- “What's the status of #12?”",
  "- “What is everyone working on?”",
  "- “Put Ada on #12” or “Put someone on #39”",
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
    if (view.project === undefined) {
      return { reply: notLoaded(), assignments: [] };
    }
    const backlog = backlogOf(view);
    if (backlog.length === 0) {
      return { reply: "Every open issue nobody is on already has an agent, so there is nothing to hand out.", assignments: [] };
    }
    return {
      reply: "Handing out the open issues nobody is on:",
      assignments: backlog.map((issue) => ({ work: `#${issue.number}`, agent: instruction.agent?.id ?? "" })),
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
        entry.slot.work.map((ref) => ({ work: workId(ref), agent: entry.agent?.id ?? "" })),
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
      lines.push(adviceFor(view));
    }
    return { reply: lines.join("\n"), assignments: [] };
  }
  if (agents.length > 0) {
    return { reply: agents.slice(0, LIST_LIMIT).map((agent) => describeAgent(agent, view)).join("\n"), assignments: [] };
  }
  const pulls = PULL_WORDS.test(message);
  const board = BOARD_WORDS.test(message);
  if (pulls && !/\bissues?\b/i.test(message)) {
    return { reply: pullRequestSummary(view), assignments: [] };
  }
  if (pulls || board) {
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

/** The backlog: open issues GitHub shows nobody on, and nobody in the office is either. */
function backlogOf(view: OfficeView): IssueView[] {
  return (view.project?.issues ?? []).filter((issue) => issue.column === "open" && issue.work === undefined);
}

/** `undefined` for "someone": whoever is free, chosen against the live office. */
type Assignee = IssueAgentView | LiveAgentView | undefined;

/** Work read from a WORK slot: what it names, and what it names that is not on the board. */
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
  while (words.length > 0 && (FILLER.test(words[words.length - 1] ?? "") || words[words.length - 1] === ",")) {
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
 * issue's full title. `null` when they are not.
 */
function readWork(words: readonly string[], view: OfficeView): WorkSlot | null {
  const plain = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const said = plain(words.join(" "));
  const titled = view.project?.issues.find((issue) => said !== "" && plain(issue.title) === said);
  if (titled !== undefined) {
    return { work: [{ kind: "issue", issue: titled }], unknown: [] };
  }

  const references: string[] = [];
  for (let at = 0; at < words.length; at += 1) {
    const word = words[at] ?? "";
    const next = words[at + 1] ?? "";
    if (/^#\d+$/.test(word)) {
      references.push(word);
    } else if ((word === "issue" || word === "pr") && NUMBER.test(next)) {
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
      const agent = readAgent(rest.slice(0, rest[and - 1] === "," ? and - 1 : and), view);
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
 * 1. VERB AGENT (on|onto|to) WORK — "put Bo on #12"
 * 2. VERB WORK to AGENT [and WORK to AGENT]* — "give #12 to Bo"
 * 3. have AGENT (take|pick up|do|handle|work on|start on) WORK — "have someone take #39"
 * 4. (hand out|give out|assign|distribute) the backlog [to AGENT]
 *
 * A message that starts like one and is not exactly one is `unclear`, and
 * nothing is acted on. `undefined` for anything else: a question, or a
 * request such as "give me the status of #12".
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

function notLoaded(): string {
  return "The project board hasn't loaded from GitHub yet, so I can't say anything about issues or pull requests.";
}

function cannotFind(unknown: readonly string[], view: OfficeView): string {
  const where = view.project === undefined ? "the project board (and it hasn't loaded from GitHub yet)" : "the project board";
  return `I can't find ${unknown.join(" or ")} on ${where}.`;
}

function workId(ref: WorkRef): string {
  switch (ref.kind) {
    case "issue":
      return `issue #${ref.issue.number}`;
    case "pull":
      return `PR #${ref.pull.number}`;
  }
}

function adviceFor(view: OfficeView): string {
  const free = freeAgents(view);
  const first = free[0];
  if (first === undefined) {
    return "Nobody suitable is free right now; name someone and I'll queue it for them.";
  }
  const short = first.split(" ")[0] ?? first;
  const say = resolveAgent(short, view)?.name === first ? short : first;
  return `${free.join(", ")} ${free.length === 1 ? "is" : "are"} free. Say “put ${say} on it” and I'll hand it over.`;
}

function describeRef(ref: WorkRef, view: OfficeView): string {
  switch (ref.kind) {
    case "issue":
      return describeIssue(ref.issue, view);
    case "pull":
      return describePull(ref.pull, view);
  }
}

/** What the office is doing about an issue, in words, or `""` when nobody is on it. */
function workText(work: WorkView | undefined): string {
  if (work === undefined) {
    return "";
  }
  const who = work.assignee ?? "someone who has left";
  switch (work.status) {
    case WORK_STATUS.assigned:
      return `${who} has it and hasn't started yet`;
    case WORK_STATUS.in_progress:
      return `${who} is working on it`;
    case WORK_STATUS.review:
      return `${who} handed in a deliverable; it is waiting for your review`;
    case WORK_STATUS.done:
      return `${who} finished it, and you approved the work`;
  }
}

/** Live agents on, or handed, a GitHub item, in words; `""` when there are none. */
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
  return parts.join("; ");
}

/** Sentences, each capitalised and closed, after a leading space; `""` for none. */
function sentences(parts: readonly string[]): string {
  const said = parts.filter((part) => part !== "").map((part) => capitalise(/[.!?]$/.test(part) ? part : `${part}.`));
  return said.length === 0 ? "" : ` ${said.join(" ")}`;
}

function labelText(labels: readonly string[]): string {
  return labels.length === 0 ? "" : ` [${labels.join(", ")}]`;
}

function describeIssue(issue: IssueView, view: OfficeView): string {
  const assignees = issue.assignees.length === 0 ? "" : `, assigned on GitHub to ${issue.assignees.join(", ")}`;
  const pulls =
    issue.pullRequests.length === 0
      ? ""
      : ` ${issue.pullRequests.map((number) => `PR #${number}`).join(", ")} ${issue.pullRequests.length === 1 ? "closes" : "close"} it.`;
  const people = sentences([workText(issue.work), liveAgentsOn(issue.url, view)]);
  const office = people === "" && issue.column !== "closed" ? " Nobody in the office is on it yet." : people;
  return `#${issue.number} “${issue.title}” is ${issue.column}${labelText(issue.labels)}${assignees}.${pulls}${office}${stale(view)}`;
}

function describePull(pull: PullRequestView, view: OfficeView): string {
  return `${pullLine(pull)}${sentences([liveAgentsOn(pull.url, view)])}${stale(view)}`;
}

function pullLine(pull: PullRequestView): string {
  const draft = pull.draft ? ", a draft," : "";
  const checks = pull.checks === "unknown" || pull.checks === "none" ? "" : ` Checks are ${pull.checks}.`;
  return `PR #${pull.number} “${pull.title}”${labelText(pull.labels)} by ${pull.author}${draft} is open.${checks}`;
}

type FloorAgent = IssueAgentView | LiveAgentView;

function isIssueAgent(agent: FloorAgent): agent is IssueAgentView {
  return !("status" in agent);
}

/** The issue an agent that takes issues has in hand, the one it is working first. */
function workInHand(agent: IssueAgentView, view: OfficeView): WorkView | undefined {
  const mine = view.work.filter((work) => work.assigneeId === agent.id);
  return (
    mine.find((work) => work.status === WORK_STATUS.in_progress) ??
    mine.find((work) => work.status === WORK_STATUS.assigned)
  );
}

function describeAgent(agent: FloorAgent, view: OfficeView): string {
  return isIssueAgent(agent) ? describeIssueAgent(agent, view) : describeLiveAgent(agent);
}

function describeIssueAgent(agent: IssueAgentView, view: OfficeView): string {
  const work = workInHand(agent, view);
  const issue = work === undefined ? "" : `#${work.issueNumber} “${work.title}”`;
  if (work?.status === WORK_STATUS.assigned) {
    return `${agent.name} (live coding agent) has ${issue} and hasn't started yet.`;
  }
  return `${agent.name} (live coding agent) is ${work === undefined ? "idle" : `working on ${issue}`}.`;
}

/** The agents free for something new, those that take issues first. */
function freeAgents(view: OfficeView): string[] {
  return [
    ...view.issueAgents.filter((agent) => workInHand(agent, view) === undefined),
    ...view.liveAgents.filter((agent) => agent.status === "idle" && agent.assigned === undefined),
  ].map((agent) => agent.name);
}

function describeLiveAgent(agent: LiveAgentView): string {
  const doing =
    agent.status === "working"
      ? `working on ${agent.task === undefined ? "something it hasn't named" : linkText(agent.task)}`
      : "idle";
  const next = agent.assigned === undefined ? "" : ` Next up: ${linkText(agent.assigned)}.`;
  return `${agent.name} (live coding agent) is ${doing}.${next}`;
}

function linkText(link: { readonly title: string; readonly reference: string }): string {
  return link.reference === "" ? `“${link.title}”` : `${link.reference} “${link.title}”`;
}

function teamSummary(view: OfficeView): string {
  const agents: FloorAgent[] = [...view.issueAgents, ...view.liveAgents];
  if (agents.length === 0) {
    return "Nobody is on the floor right now: there are no agents to report on.";
  }
  const lines = ["Live coding agents:", ...agents.map((agent) => `- ${describeAgent(agent, view)}`)];
  const free = freeAgents(view);
  lines.push(free.length === 0 ? "Nobody is free." : `Free for something new: ${free.join(", ")}.`);
  return lines.join("\n");
}

/** One open issue in a list: its labels, and who in the office is on it. */
function issueItem(issue: IssueView): string {
  const who =
    issue.work === undefined ? "" : ` — ${issue.work.assignee ?? "someone who has left"}, ${WORK_TEXT[issue.work.status]}`;
  return `#${issue.number} “${issue.title}”${labelText(issue.labels)}${who}`;
}

function boardSummary(view: OfficeView): string {
  const project = view.project;
  if (project === undefined) {
    return notLoaded();
  }
  const open = project.issues.filter((issue) => issue.column !== "closed");
  const worked = open.filter((issue) => issue.work !== undefined);
  const lines = [
    `${project.repository}: ${project.counts.open + project.counts.inProgress} open issues (${project.counts.inProgress} in progress on GitHub), ${worked.length} with an agent on them, ${project.counts.pullRequests} open pull requests.${stale(view)}`,
  ];
  if (open.length > 0) {
    lines.push(`Open: ${list(open.map(issueItem))}.`);
  }
  const review = view.work.filter((work) => work.status === WORK_STATUS.review);
  if (review.length > 0) {
    lines.push(`Waiting for your review: ${list(review.map((work) => `#${work.issueNumber} (${work.assignee ?? "unknown"})`))}.`);
  }
  const backlog = backlogOf(view);
  if (backlog.length > 0) {
    lines.push(`Nobody on yet: ${list(backlog.map((issue) => `#${issue.number}`))}.`);
  }
  if (project.pullRequests.length > 0) {
    lines.push(`Open pull requests: ${list(project.pullRequests.map((pull) => `PR #${pull.number}${pull.checks === "failing" ? " (checks failing)" : ""}`))}.`);
  }
  return lines.join("\n");
}

function pullRequestSummary(view: OfficeView): string {
  const project = view.project;
  if (project === undefined) {
    return notLoaded();
  }
  if (project.pullRequests.length === 0) {
    return `${project.repository} has no open pull requests.${stale(view)}`;
  }
  const shown = project.pullRequests.slice(0, LIST_LIMIT);
  const more = project.counts.pullRequests - shown.length;
  return [
    `${project.repository} has ${project.counts.pullRequests} open pull requests:${stale(view)}`,
    ...shown.map((pull) => `- ${pullLine(pull)}`),
    ...(more > 0 ? [`…and ${more} more on GitHub.`] : []),
  ].join("\n");
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
