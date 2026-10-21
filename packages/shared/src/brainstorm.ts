/**
 * Brainstorm tickets: an issue labelled {@link BRAINSTORM_LABEL} on GitHub is
 * an idea for several agents to research, never code to write.
 *
 * The CEO hands one to two or more agents at once, in one of two modes
 * ({@link BRAINSTORM_MODE}): each writes a take of its own (expand the idea,
 * judge whether it is doable, suggest alternatives), or one researcher expands
 * it and the others review and challenge what it wrote. Once every write-up is
 * in, one of them merges them into a recommendation. The agents only read: their
 * runner runs them with read-only tools in a scratch checkout, on no branch,
 * and opens no pull request (`apps/runner/src/agents/brainstorm.ts`). Their
 * write-ups and an optional meeting-room discussion make one design document,
 * {@link designDocument}, which the office keeps on the idea and its runner
 * posts on the issue. Anyone in the office then marks it reviewed and turns it
 * into one or more implementation issues, drafted from the document by
 * {@link draftIssues} and edited before the runner creates them.
 *
 * What the office is doing about an idea is replicated state (`Brainstorm` in
 * `./state.ts`), run by the server (`apps/server/src/agents/brainstorms.ts`);
 * this module is what both sides need: the rules, so a button the server would
 * refuse is disabled and says why, and the document, so every tab reads the
 * same one without the server sending it twice.
 */

import type { BoardIssue } from "./projectBoard.js";
import { OCCUPANT_KIND } from "./state.js";
import { asRecord, clip, isIssueNumber } from "./text.js";
import { type OfficeActor, isAgentRestricted, isIssueAssignee } from "./work.js";
import { sanitizeBody, sanitizeTitle } from "./messages.js";

/** The GitHub label that makes an issue a brainstorm ticket, compared without regard to case. */
export const BRAINSTORM_LABEL = "brainstorm";

/** Whether an issue carries {@link BRAINSTORM_LABEL}. */
export function isBrainstormIssue(issue: Pick<BoardIssue, "labels">): boolean {
  return issue.labels.some((label) => label.name.toLowerCase() === BRAINSTORM_LABEL);
}

/** How the agents research an idea; the CEO picks one when assigning. */
export const BRAINSTORM_MODE = {
  /** Every agent writes a take of its own. */
  takes: "takes",
  /** The first agent researches and expands the idea; the others review and challenge its write-up. */
  critics: "critics",
} as const;

export type BrainstormMode = (typeof BRAINSTORM_MODE)[keyof typeof BRAINSTORM_MODE];

export function isBrainstormMode(value: unknown): value is BrainstormMode {
  return value === BRAINSTORM_MODE.takes || value === BRAINSTORM_MODE.critics;
}

/** What one agent's run on an idea is for. */
export const BRAINSTORM_ROLE = {
  take: "take",
  researcher: "researcher",
  critic: "critic",
  /** Merges every write-up into the design document's recommendation. */
  synthesis: "synthesis",
} as const;

export type BrainstormRole = (typeof BRAINSTORM_ROLE)[keyof typeof BRAINSTORM_ROLE];

export function isBrainstormRole(value: unknown): value is BrainstormRole {
  return typeof value === "string" && (Object.values(BRAINSTORM_ROLE) as string[]).includes(value);
}

/** How far the office has got with an idea. */
export const BRAINSTORM_STATUS = {
  /** The agents are writing their write-ups. */
  researching: "researching",
  /** One agent is merging them into a recommendation. */
  synthesizing: "synthesizing",
  /** The design document is written, for the office to review. */
  ready: "ready",
  /** The agents are discussing it in the meeting room. */
  meeting: "meeting",
  /** Someone read the document and marked it reviewed: it can be converted. */
  reviewed: "reviewed",
  /** Implementation issues were created from it and the idea closed. */
  converted: "converted",
  /** No agent's research came back; `note` says why. It can be assigned again. */
  failed: "failed",
} as const;

export type BrainstormStatus = (typeof BRAINSTORM_STATUS)[keyof typeof BRAINSTORM_STATUS];

/** How one agent's write-up stands. */
export const BRAINSTORM_TAKE_STATUS = {
  /** A critic, waiting for the researcher's write-up to review. */
  waiting: "waiting",
  working: "working",
  done: "done",
  /** It came back with nothing; the take's `note` says why. */
  failed: "failed",
} as const;

export type BrainstormTakeStatus = (typeof BRAINSTORM_TAKE_STATUS)[keyof typeof BRAINSTORM_TAKE_STATUS];

/** What came of posting the design document on the issue, or of converting the idea. */
export const BRAINSTORM_GITHUB = {
  none: "",
  sending: "sending",
  done: "done",
  failed: "failed",
} as const;

export type BrainstormGithubStatus = (typeof BRAINSTORM_GITHUB)[keyof typeof BRAINSTORM_GITHUB];

/** An agent's judgement of whether the idea can be done, read off its write-up's `Verdict:` line. */
export const BRAINSTORM_VERDICT = {
  doable: "doable",
  caveats: "doable with caveats",
  notDoable: "not doable",
  /** It gave none the office could read. */
  unknown: "",
} as const;

export type BrainstormVerdict = (typeof BRAINSTORM_VERDICT)[keyof typeof BRAINSTORM_VERDICT];

/** Fewest agents an idea is given to: one alone is an ordinary issue's work. */
export const MIN_BRAINSTORM_AGENTS = 2;

/** Most agents an idea is given to, the most slots the floor holds. */
export const MAX_BRAINSTORM_AGENTS = 4;

/**
 * Longest write-up, recommendation or meeting summary, in bytes as the sync
 * measures them: about 600 words, and the reason a sync carries one at most.
 */
export const MAX_BRAINSTORM_TEXT_BYTES = 4000;

/** Rounds of the meeting: each agent speaks once a round, then one sums it up. */
export const BRAINSTORM_MEETING_ROUNDS = 2;

/** Most implementation issues one conversion creates. */
export const MAX_BRAINSTORM_DRAFTS = 5;

/** Longest drafted issue's title, GitHub's own being 256. */
export const MAX_DRAFT_TITLE_LENGTH = 200;

/** Longest drafted issue's body. */
export const MAX_DRAFT_BODY_LENGTH = 8000;

/** Why the office did not take a brainstorm command. Refusal changes nothing. */
export const BRAINSTORM_REJECTION = {
  /** Only the CEO hands an idea out or calls its meeting; only a player reviews or converts one. */
  forbidden: "forbidden",
  /** The board shows no open issue with that number. */
  unknownIssue: "unknown-issue",
  /** The issue is not labelled `brainstorm`. */
  notBrainstorm: "not-brainstorm",
  /** It carries the label that keeps every agent off it. */
  restricted: "restricted",
  /** Fewer than two agents, or more than four. */
  agentCount: "agent-count",
  /** An agent named is not one in the office that takes issues. */
  unknownAgent: "unknown-agent",
  /** An agent named already has an issue, or another idea, in hand. */
  busy: "busy",
  /** The idea is already being researched, or was, or the issue is an ordinary one's work. */
  running: "running",
  /** The idea is not at the step that command is for. */
  wrongStep: "wrong-step",
  /** A standup, or another idea's meeting, has the meeting room. */
  roomTaken: "room-taken",
  /** Fewer than two of its agents are free on the floor to meet. */
  noAgents: "no-agents",
  /** No runner that writes to GitHub is connected. */
  noRunner: "no-runner",
  /** A conversion with no issue to create, or a drafted issue with no title. */
  noDrafts: "no-drafts",
} as const;

export type BrainstormRejection = (typeof BRAINSTORM_REJECTION)[keyof typeof BRAINSTORM_REJECTION];

/** One agent's write-up, without the schema around it. */
export interface BrainstormTakeData {
  readonly agentId: string;
  readonly agentName: string;
  readonly role: BrainstormRole | string;
  readonly status: BrainstormTakeStatus | string;
  readonly text: string;
  readonly verdict: BrainstormVerdict | string;
  readonly note: string;
}

/** An implementation issue a conversion created. */
export interface BrainstormIssueData {
  readonly number: number;
  readonly url: string;
}

/** An idea's record, without the schema around it, as the client renders it. */
export interface BrainstormData {
  readonly issueNumber: number;
  readonly title: string;
  readonly mode: BrainstormMode | string;
  readonly status: BrainstormStatus | string;
  readonly requestedBy: string;
  readonly takes: readonly BrainstormTakeData[];
  readonly synthesis: string;
  /** Who wrote the recommendation, by name; `""` until one has. */
  readonly synthesizedBy: string;
  readonly meetingSummary: string;
  readonly note: string;
  readonly postStatus: BrainstormGithubStatus | string;
  readonly convertStatus: BrainstormGithubStatus | string;
  readonly reviewedBy: string;
  readonly created: readonly BrainstormIssueData[];
  readonly startedAt: number;
  readonly updatedAt: number;
}

/** The steps an idea holds its agents through: they take no other work meanwhile. */
const HOLDING: ReadonlySet<string> = new Set([BRAINSTORM_STATUS.researching, BRAINSTORM_STATUS.synthesizing, BRAINSTORM_STATUS.meeting]);

/**
 * The idea an agent is held by, as its issue number, or `undefined`: an agent
 * researching an idea, merging its write-ups or at its meeting takes no other
 * work, as an agent with an issue in hand takes none (`heldIssue`).
 */
export function brainstormHeld(
  agentId: string,
  brainstorms: Iterable<{ readonly issueNumber: number; readonly status: string; readonly takes: Iterable<{ readonly agentId: string }> }>,
): number | undefined {
  for (const brainstorm of brainstorms) {
    if (HOLDING.has(brainstorm.status) && [...brainstorm.takes].some((take) => take.agentId === agentId)) {
      return brainstorm.issueNumber;
    }
  }
  return undefined;
}

/** A parsed `brainstorm:assign` payload. */
export interface BrainstormAssignMessage {
  readonly issueNumber: number;
  /** In the order picked: in the critics' mode the first is the researcher. Never repeats one. */
  readonly agentIds: readonly string[];
  readonly mode: BrainstormMode;
}

/** A parsed `brainstorm:meet` or `brainstorm:review` payload. */
export interface BrainstormIssueMessage {
  readonly issueNumber: number;
}

/** One implementation issue to create. */
export interface BrainstormDraft {
  readonly title: string;
  readonly body: string;
}

/** A parsed `brainstorm:convert` payload. */
export interface BrainstormConvertMessage {
  readonly issueNumber: number;
  readonly drafts: readonly BrainstormDraft[];
}

/** Sent only to the client whose brainstorm command the office refused, with the reason. */
export interface BrainstormRejectedEvent {
  readonly issueNumber: number;
  readonly rejection: BrainstormRejection;
}

const MAX_AGENT_ID_LENGTH = 96;

function isAgentId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_AGENT_ID_LENGTH;
}

/** Validates a raw `brainstorm:assign` payload. Shape only: whether it may be done is {@link brainstormAssignRefusal}'s call. */
export function parseBrainstormAssignMessage(raw: unknown): BrainstormAssignMessage | undefined {
  const candidate = asRecord(raw);
  const ids = candidate?.["agentIds"];
  if (
    candidate === undefined ||
    !isIssueNumber(candidate["issueNumber"]) ||
    !isBrainstormMode(candidate["mode"]) ||
    !Array.isArray(ids) ||
    ids.length > MAX_BRAINSTORM_AGENTS ||
    !ids.every(isAgentId) ||
    new Set(ids).size !== ids.length
  ) {
    return undefined;
  }
  return { issueNumber: candidate["issueNumber"], agentIds: [...ids], mode: candidate["mode"] };
}

/** Validates a raw `brainstorm:meet` or `brainstorm:review` payload. */
export function parseBrainstormIssueMessage(raw: unknown): BrainstormIssueMessage | undefined {
  const candidate = asRecord(raw);
  return candidate !== undefined && isIssueNumber(candidate["issueNumber"]) ? { issueNumber: candidate["issueNumber"] } : undefined;
}

/**
 * Validates a raw `brainstorm:convert` payload: one to {@link MAX_BRAINSTORM_DRAFTS}
 * drafts, each with a title. A title is one line; a body keeps its paragraphs.
 */
export function parseBrainstormConvertMessage(raw: unknown): BrainstormConvertMessage | undefined {
  const candidate = asRecord(raw);
  const drafts = candidate?.["drafts"];
  if (candidate === undefined || !isIssueNumber(candidate["issueNumber"]) || !Array.isArray(drafts)) {
    return undefined;
  }
  if (drafts.length === 0 || drafts.length > MAX_BRAINSTORM_DRAFTS) {
    return undefined;
  }
  const parsed: BrainstormDraft[] = [];
  for (const draft of drafts) {
    const record = asRecord(draft);
    const title = sanitizeTitle(record?.["title"], MAX_DRAFT_TITLE_LENGTH);
    if (record === undefined || title === "" || typeof record["body"] !== "string") {
      return undefined;
    }
    parsed.push({ title, body: sanitizeBody(record["body"], MAX_DRAFT_BODY_LENGTH) });
  }
  return { issueNumber: candidate["issueNumber"], drafts: parsed };
}

/** One agent the CEO named, as the rules need to know it; `undefined` for nobody in the office. */
export interface BrainstormCandidate {
  readonly kind: OfficeActor["kind"];
  readonly canTakeIssues?: boolean;
  /** It has an issue or another idea in hand. */
  readonly busy: boolean;
}

/** Everything the assignment rule reads, so the client asks it with what it can see. */
export interface BrainstormAssignContext {
  readonly actor: OfficeActor;
  /** The issue, open on the board; `undefined` when the board shows no open issue by that number. */
  readonly issue: Pick<BoardIssue, "labels"> | undefined;
  readonly restrictLabel: string;
  /** The idea's record, if the office has one. */
  readonly existing: Pick<BrainstormData, "status"> | undefined;
  /** Whether the issue is an ordinary issue's work in the office. */
  readonly hasWork: boolean;
  readonly agents: readonly (BrainstormCandidate | undefined)[];
}

/**
 * Whether the CEO may hand an idea to these agents, and if not, why. **The one
 * gate**, asked by the server for every command and by the board to disable
 * its button: only the CEO hands work out, the issue must be an open idea no
 * agent is kept from, not already being researched, and every agent named must
 * be one that takes issues and has none, nor another idea, in hand. An idea
 * whose research failed may be handed out again.
 */
export function brainstormAssignRefusal(context: BrainstormAssignContext): BrainstormRejection | undefined {
  if (!context.actor.isCeo) {
    return BRAINSTORM_REJECTION.forbidden;
  }
  if (context.issue === undefined) {
    return BRAINSTORM_REJECTION.unknownIssue;
  }
  if (!isBrainstormIssue(context.issue)) {
    return BRAINSTORM_REJECTION.notBrainstorm;
  }
  if (isAgentRestricted(context.issue, context.restrictLabel)) {
    return BRAINSTORM_REJECTION.restricted;
  }
  if (context.hasWork || (context.existing !== undefined && context.existing.status !== BRAINSTORM_STATUS.failed)) {
    return BRAINSTORM_REJECTION.running;
  }
  if (context.agents.length < MIN_BRAINSTORM_AGENTS || context.agents.length > MAX_BRAINSTORM_AGENTS) {
    return BRAINSTORM_REJECTION.agentCount;
  }
  if (context.agents.some((agent) => agent === undefined || !isIssueAssignee(agent))) {
    return BRAINSTORM_REJECTION.unknownAgent;
  }
  if (context.agents.some((agent) => agent?.busy === true)) {
    return BRAINSTORM_REJECTION.busy;
  }
  return undefined;
}

/** What else may be done with an idea once its research is in. */
export const BRAINSTORM_ACTION = {
  /** Gather its agents in the meeting room to discuss it: the CEO's, since it costs a run a line. */
  meet: "meet",
  /** Say its design document has been read: anyone in the office. */
  review: "review",
  /** Create implementation issues from it and close it: anyone in the office. */
  convert: "convert",
} as const;

export type BrainstormAction = (typeof BRAINSTORM_ACTION)[keyof typeof BRAINSTORM_ACTION];

/** What {@link brainstormActionRefusal} reads besides the actor and the idea. */
export interface BrainstormActionContext {
  /** A standup or another idea's meeting has the meeting room. */
  readonly roomTaken: boolean;
  /** How many of the idea's agents are on the floor with nothing in hand. */
  readonly freeAgents: number;
  /** A runner that writes to GitHub is connected; the replicated `issuesWritable`. */
  readonly writable: boolean;
}

/**
 * Whether an actor may do this to an idea now, and if not, why. **The one gate**
 * for the meeting, the review and the conversion, asked by the server for
 * every command and by the board for its buttons.
 */
export function brainstormActionRefusal(
  action: BrainstormAction,
  actor: OfficeActor,
  brainstorm: Pick<BrainstormData, "status"> | undefined,
  context: BrainstormActionContext,
): BrainstormRejection | undefined {
  const isPlayer = actor.kind === OCCUPANT_KIND.human;
  switch (action) {
    case BRAINSTORM_ACTION.meet:
      if (!actor.isCeo) {
        return BRAINSTORM_REJECTION.forbidden;
      }
      if (brainstorm?.status !== BRAINSTORM_STATUS.ready && brainstorm?.status !== BRAINSTORM_STATUS.reviewed) {
        return BRAINSTORM_REJECTION.wrongStep;
      }
      if (context.roomTaken) {
        return BRAINSTORM_REJECTION.roomTaken;
      }
      return context.freeAgents < MIN_BRAINSTORM_AGENTS ? BRAINSTORM_REJECTION.noAgents : undefined;
    case BRAINSTORM_ACTION.review:
      if (!isPlayer) {
        return BRAINSTORM_REJECTION.forbidden;
      }
      return brainstorm?.status === BRAINSTORM_STATUS.ready ? undefined : BRAINSTORM_REJECTION.wrongStep;
    case BRAINSTORM_ACTION.convert:
      if (!isPlayer) {
        return BRAINSTORM_REJECTION.forbidden;
      }
      if (brainstorm?.status !== BRAINSTORM_STATUS.reviewed) {
        return BRAINSTORM_REJECTION.wrongStep;
      }
      return context.writable ? undefined : BRAINSTORM_REJECTION.noRunner;
  }
}

/** What the board says of a refusal. */
export function brainstormRejectionText(rejection: BrainstormRejection): string {
  switch (rejection) {
    case BRAINSTORM_REJECTION.forbidden:
      return "Only the CEO can hand an idea to agents or call its meeting.";
    case BRAINSTORM_REJECTION.unknownIssue:
      return "The board shows no open issue by that number.";
    case BRAINSTORM_REJECTION.notBrainstorm:
      return `That issue is not labelled ${BRAINSTORM_LABEL}.`;
    case BRAINSTORM_REJECTION.restricted:
      return "That issue carries the label that keeps every agent off it.";
    case BRAINSTORM_REJECTION.agentCount:
      return `Pick ${MIN_BRAINSTORM_AGENTS} to ${MAX_BRAINSTORM_AGENTS} agents.`;
    case BRAINSTORM_REJECTION.unknownAgent:
      return "An agent picked is no longer in the office, or takes no issues.";
    case BRAINSTORM_REJECTION.busy:
      return "An agent picked is busy with other work.";
    case BRAINSTORM_REJECTION.running:
      return "That idea is already being worked on.";
    case BRAINSTORM_REJECTION.wrongStep:
      return "The idea is not at that step.";
    case BRAINSTORM_REJECTION.roomTaken:
      return "The meeting room is taken: a standup or another idea's meeting is on.";
    case BRAINSTORM_REJECTION.noAgents:
      return `Fewer than ${MIN_BRAINSTORM_AGENTS} of its agents are free on the floor to meet.`;
    case BRAINSTORM_REJECTION.noRunner:
      return "No agent runner that writes to GitHub is connected.";
    case BRAINSTORM_REJECTION.noDrafts:
      return "Each issue to create needs a title.";
  }
}

/** The verdict a write-up gives on its `Verdict:` line, the first such line it has. */
export function takeVerdict(text: string): BrainstormVerdict {
  const line = /^[\s>*_#-]*verdict[\s*_]*:[\s*_]*(.+)$/im.exec(text)?.[1]?.toLowerCase() ?? "";
  if (line.startsWith("not doable") || line.startsWith("not feasible")) {
    return BRAINSTORM_VERDICT.notDoable;
  }
  if (line.startsWith("doable with caveats") || line.startsWith("doable, with caveats")) {
    return BRAINSTORM_VERDICT.caveats;
  }
  return line.startsWith("doable") ? BRAINSTORM_VERDICT.doable : BRAINSTORM_VERDICT.unknown;
}

/** A take's role, as the document heads it. */
const ROLE_HEADING: Readonly<Record<string, string>> = {
  [BRAINSTORM_ROLE.take]: "take",
  [BRAINSTORM_ROLE.researcher]: "researcher",
  [BRAINSTORM_ROLE.critic]: "critic",
};

/**
 * The idea's design document, in GitHub Markdown: the recommendation that
 * merged the write-ups, the meeting's summary when there was one, then every
 * agent's write-up with its verdict. Built the same way wherever it is read,
 * from the replicated record, and posted on the issue as it stands.
 */
export function designDocument(brainstorm: BrainstormData): string {
  const lines = [`# Design document: ${brainstorm.title} (#${brainstorm.issueNumber})`, ""];
  lines.push(
    `Researched by ${brainstorm.takes.map((take) => take.agentName).join(", ")}, ` +
      (brainstorm.mode === BRAINSTORM_MODE.critics ? "a researcher and its critics" : "each writing a take") +
      (brainstorm.requestedBy === "" ? "." : `, for ${brainstorm.requestedBy}.`),
    "",
    "## Recommendation",
    "",
    brainstorm.synthesis === ""
      ? "_No recommendation was written; read the write-ups below._"
      : `${brainstorm.synthesis}${brainstorm.synthesizedBy === "" ? "" : `\n\n— ${brainstorm.synthesizedBy}`}`,
    "",
  );
  if (brainstorm.meetingSummary !== "") {
    lines.push("## Meeting summary", "", brainstorm.meetingSummary, "");
  }
  lines.push("## Research", "");
  for (const take of brainstorm.takes) {
    const verdict = take.verdict === "" ? "" : ` · ${take.verdict}`;
    lines.push(`### ${take.agentName} (${ROLE_HEADING[take.role] ?? take.role}${verdict})`, "");
    lines.push(take.status === BRAINSTORM_TAKE_STATUS.done ? take.text : `_No write-up: ${take.note || "it did not finish"}._`, "");
  }
  return lines.join("\n").trimEnd();
}

/**
 * The implementation issue a conversion starts from, for the player to edit:
 * the idea's title, and the recommendation, or the meeting's summary, with a
 * line back to the idea. One draft; the player adds more for a recommendation
 * that is several features.
 */
export function draftIssues(brainstorm: BrainstormData): BrainstormDraft[] {
  const basis = brainstorm.synthesis !== "" ? brainstorm.synthesis : brainstorm.meetingSummary;
  const body = [basis, `From the brainstorm in #${brainstorm.issueNumber}, whose design document is on that issue.`]
    .filter((part) => part !== "")
    .join("\n\n");
  return [{ title: clip(brainstorm.title, MAX_DRAFT_TITLE_LENGTH), body: clip(body, MAX_DRAFT_BODY_LENGTH) }];
}

/** What the board's badge says an idea's work is at. */
export function brainstormStatusText(brainstorm: Pick<BrainstormData, "status" | "takes">): string {
  const done = brainstorm.takes.filter((take) => take.status === BRAINSTORM_TAKE_STATUS.done).length;
  switch (brainstorm.status) {
    case BRAINSTORM_STATUS.researching:
      return `Researching: ${done} of ${brainstorm.takes.length} write-ups in`;
    case BRAINSTORM_STATUS.synthesizing:
      return "Writing the recommendation";
    case BRAINSTORM_STATUS.ready:
      return "Design document ready for review";
    case BRAINSTORM_STATUS.meeting:
      return "Discussing it in the meeting room";
    case BRAINSTORM_STATUS.reviewed:
      return "Reviewed, ready to convert";
    case BRAINSTORM_STATUS.converted:
      return "Converted into issues";
    default:
      return "Research failed";
  }
}
