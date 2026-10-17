/**
 * The messages that cross the socket, and their parsers.
 *
 * Everything arriving from a client arrives as `unknown` from a browser nobody
 * controls, so each client message type ships with the parser that proves a
 * payload is one. The server never reads a field off a raw message directly.
 *
 * Server -> client events are the other half. They carry no parser: the server
 * has already validated and sanitized everything it broadcasts, which is the
 * point of routing expression through it rather than peer to peer. A client
 * receiving a {@link ChatEvent} can render its text without re-checking it.
 *
 * Replicated state in `state.ts` covers what is continuously true — where
 * everyone is standing. These messages cover what merely happened at a moment:
 * a wave, a sentence. Nothing transient belongs in the schema, where a late
 * joiner would receive it as if it were still going on.
 */

import type { AgentPromptRejection } from "./agentPrompt.js";
import {
  MAX_AGENT_PROMPT_LENGTH,
  MAX_CHAT_LENGTH,
  MAX_MANAGER_MESSAGE_LENGTH,
  MAX_MANAGER_REPLY_LENGTH,
  MAX_WORK_NOTE_LENGTH,
} from "./constants.js";
import type { ManagerRejection } from "./manager.js";
import { MAX_OPERATOR_PASSPHRASE_LENGTH, type OperatorRejection } from "./operator.js";
import { ANIMATION_STATE, type ReportedAnimation, type WorkStatus, isWorkStatus } from "./state.js";
import type { WorkAction, WorkRejection } from "./work.js";

/** Matchmaking name of the only room type this milestone defines. */
export const OFFICE_ROOM_NAME = "office";

export const CLIENT_MESSAGE = {
  /** The client's own pose, sent on a fixed interval while it is connected. */
  pose: "pose",
  /** A gesture from the fixed {@link EMOTE} vocabulary. */
  emote: "emote",
  /** A line of text chat. */
  chat: "chat",
  /** A request to use a named interactable the sender believes it is next to. */
  interact: "interact",
  /** A request to stop using whatever the sender is currently engaged with. */
  release: "release",
  /** Give an open GitHub issue to an agent, or hand its work to another. */
  workAssign: "work:assign",
  /** Take an issue back off the agent it was given to before they started it. */
  workRelease: "work:release",
  /** Move an issue's work to an adjacent status: approve it, send it back, retry it. */
  workMove: "work:move",
  /** Say something to the AI manager; only the CEO is listened to. */
  managerSay: "manager:say",
  /** Prove the operator passphrase, to command the real coding agents; see `operator.ts`. */
  operatorVerify: "operator:verify",
  /** Type a prompt into a coding agent's terminal; only the CEO is listened to. See `agentPrompt.ts`. */
  agentPrompt: "agent:prompt",
} as const;

export type ClientMessageType = (typeof CLIENT_MESSAGE)[keyof typeof CLIENT_MESSAGE];

export const SERVER_MESSAGE = {
  /** An occupant emoted; every client in the room draws it. */
  emote: "emote",
  /** An occupant said something; every client in the room draws and logs it. */
  chat: "chat",
  /** Sent only to the client whose message was dropped by a rate limit. */
  throttled: "throttled",
  /**
   * The project board's GitHub snapshot, a `ProjectBoardSnapshot` from
   * `projectBoard.ts`. Sent to each client as it joins and broadcast whenever
   * the server's feed replaces it.
   */
  projectBoard: "project-board",
  /**
   * Sent only to the client whose work command the office refused, so a
   * refusal is distinguishable from a lost message. Carries a
   * {@link WorkRejectedEvent}.
   */
  workRejected: "work-rejected",
  /**
   * The CEO role passed to someone else, because its holder left or because
   * someone verified as operator. Broadcast to every client as a
   * {@link CeoChangedEvent}; the role itself is replicated state, so this is
   * the announcement, not the change.
   */
  ceoChanged: "ceo-changed",
  /**
   * The conversation with the AI manager so far, a {@link ManagerHistoryEvent},
   * sent to each client as it joins.
   */
  managerHistory: "manager:history",
  /**
   * One new line in that conversation, a {@link ManagerEntry}: the CEO's
   * instruction, the manager's reply, or an update it posted on its own.
   * Broadcast to every client, since everyone may read the conversation.
   */
  managerEntry: "manager:entry",
  /**
   * Sent only to the client whose message the manager did not take, with the
   * reason. Carries a {@link ManagerRejectedEvent}.
   */
  managerRejected: "manager:rejected",
  /**
   * Agent terminals, a `ScreenFramesEvent` from `screens.ts`: each batch of
   * diffs the server accepts from a runner, broadcast to every client, and a
   * full frame of every screen, sent to each client as it joins.
   */
  screens: "screens",
  /**
   * Sent only to the client whose operator verification was turned down, with
   * the reason. Carries an {@link OperatorRejectedEvent}. A verification that
   * succeeds needs no reply: the player's replicated operator flag is it.
   */
  operatorRejected: "operator:rejected",
  /**
   * A prompt the CEO sent a coding agent was typed into its terminal, an
   * {@link AgentPromptEntry}. Broadcast to every client, since everyone
   * watching that agent's terminal should know why it changed course.
   */
  agentPrompted: "agent:prompted",
  /**
   * The prompts typed into the coding agents' terminals lately, an
   * {@link AgentPromptHistoryEvent}, sent to each client as it joins.
   */
  agentPromptHistory: "agent:prompt-history",
  /**
   * Sent only to the client whose prompt was not typed, with the reason.
   * Carries an {@link AgentPromptRejectedEvent}.
   */
  agentPromptRejected: "agent:prompt-rejected",
} as const;

export type ServerMessageType = (typeof SERVER_MESSAGE)[keyof typeof SERVER_MESSAGE];

/**
 * The gestures an occupant can perform.
 *
 * A closed vocabulary rather than free text: every value here has to have a
 * sprite drawn for it, and a client cannot invent a sixth one.
 */
export const EMOTE = {
  wave: "wave",
  laugh: "laugh",
  shrug: "shrug",
  point: "point",
  thumbsUp: "thumbsUp",
} as const;

export type Emote = (typeof EMOTE)[keyof typeof EMOTE];

/** Every emote, in the order the HUD offers them. */
export const EMOTES: readonly Emote[] = [
  EMOTE.wave,
  EMOTE.laugh,
  EMOTE.shrug,
  EMOTE.point,
  EMOTE.thumbsUp,
];

/** Where the sending client believes it is, in world units. */
export interface PoseMessage {
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly animation: ReportedAnimation;
}

/**
 * Which interactable a client wants to use.
 *
 * The id alone: the client does not get to say where it is standing, how far
 * away it is, or what the interaction should do. The server already knows all
 * three from the pose it has accepted and the shared layout.
 */
export interface InteractMessage {
  readonly target: string;
}

/** A gesture the sending client wants to perform. */
export interface EmoteMessage {
  readonly emote: Emote;
}

/** Something the sending client wants to say out loud. */
export interface ChatMessage {
  /** Already sanitized by {@link parseChatMessage}, and never empty. */
  readonly text: string;
}

/** An occupant emoted, as broadcast to every client in the room. */
export interface EmoteEvent {
  readonly occupantId: string;
  readonly emote: Emote;
}

/** An occupant spoke, as broadcast to every client in the room. */
export interface ChatEvent {
  readonly occupantId: string;
  /** Sanitized and length-capped. Safe to render as text. */
  readonly text: string;
}

/** A client's own message was dropped because it was sending too fast. */
export interface ThrottledEvent {
  readonly command:
    | typeof CLIENT_MESSAGE.emote
    | typeof CLIENT_MESSAGE.chat
    | typeof CLIENT_MESSAGE.managerSay
    | typeof CLIENT_MESSAGE.agentPrompt;
}

/**
 * The office refused one of this client's work commands and changed nothing.
 *
 * `rejection` is the reason, so a client can say "only the CEO can do that"
 * rather than a generic failure.
 */
export interface WorkRejectedEvent {
  readonly action: WorkAction;
  readonly rejection: WorkRejection;
}

/** Why the CEO role changed hands. */
export const CEO_CHANGE = {
  /** Its holder left the office, and whoever had been there longest took it. */
  succeeded: "succeeded",
  /** Someone verified as operator and took it from its holder, who stays as an executive. */
  operator: "operator",
} as const;

export type CeoChange = (typeof CEO_CHANGE)[keyof typeof CEO_CHANGE];

/** Who holds the CEO role now, who held it before, and why it moved. */
export interface CeoChangedEvent {
  /** Occupant id of the new CEO. */
  readonly ceoId: string;
  /**
   * Occupant id of the previous CEO. After a {@link CEO_CHANGE.succeeded} they
   * have left, and are no longer resolvable in the occupants map.
   */
  readonly previousCeoId: string;
  readonly change: CeoChange;
}

/** The office turned down this client's attempt to verify as operator. */
export interface OperatorRejectedEvent {
  readonly rejection: OperatorRejection;
}

/** Who wrote a line in the conversation with the AI manager, and why. */
export const MANAGER_ENTRY_KIND = {
  /** The CEO, telling or asking the manager something. */
  instruction: "instruction",
  /** The manager, answering the instruction before it. */
  reply: "reply",
  /** The manager, unprompted: work handed in, an agent stuck, an assignment picked up. */
  update: "update",
} as const;

export type ManagerEntryKind = (typeof MANAGER_ENTRY_KIND)[keyof typeof MANAGER_ENTRY_KIND];

/**
 * One line in the conversation with the AI manager.
 *
 * Carries the author's name rather than only an id, because the conversation
 * outlives whoever was CEO when a line was written.
 */
export interface ManagerEntry {
  /** Increasing within a room, so a client can tell a line it already has. */
  readonly id: number;
  readonly kind: ManagerEntryKind;
  readonly authorName: string;
  /**
   * Sanitized and length-capped by the server. Safe to render as text; may
   * hold newlines, which a reply uses for a list.
   */
  readonly text: string;
  /** Epoch milliseconds. */
  readonly at: number;
}

/** The conversation so far, oldest first, as a joining client is handed it. */
export interface ManagerHistoryEvent {
  readonly entries: readonly ManagerEntry[];
}

/** The manager did not take one of this client's messages, and why. */
export interface ManagerRejectedEvent {
  readonly rejection: ManagerRejection;
}

/** Something the sending client wants to tell the AI manager. */
export interface ManagerSayMessage {
  /** Already sanitized by {@link parseManagerSayMessage}, and never empty. */
  readonly text: string;
}

/** An attempt at the operator passphrase. */
export interface OperatorVerifyMessage {
  /** Exactly as typed: a passphrase is compared, never sanitized. */
  readonly passphrase: string;
}

/** Something the CEO wants typed into a coding agent's terminal. */
export interface AgentPromptMessage {
  /** The agent's occupant key. */
  readonly agentId: string;
  /** Already sanitized by {@link parseAgentPromptMessage}, and never empty; may hold newlines. */
  readonly text: string;
}

/** A prompt that was typed into a coding agent's terminal, as every client is told. */
export interface AgentPromptEntry {
  /** Increasing within a room, so a client can tell an entry it already has. */
  readonly id: number;
  /** The agent's occupant key. */
  readonly agentId: string;
  /** By name, since the agent may have left by the time the entry is read. */
  readonly agentName: string;
  /** Occupant id of the CEO who sent it. */
  readonly authorId: string;
  readonly authorName: string;
  /** Sanitized by the server. Safe to render as text; may hold newlines. */
  readonly text: string;
  /** Epoch milliseconds. */
  readonly at: number;
}

/** The prompts typed lately, oldest first, as a joining client is handed them. */
export interface AgentPromptHistoryEvent {
  readonly entries: readonly AgentPromptEntry[];
}

/** One of this client's prompts was not typed into the agent's terminal, and why. */
export interface AgentPromptRejectedEvent {
  readonly agentId: string;
  readonly rejection: AgentPromptRejection;
}

/** Options a client may supply when joining the office room. */
export interface JoinOptions {
  readonly name?: string;
}

/**
 * The three work commands, all the CEO's.
 *
 * An issue is named by its GitHub number. Whether that issue is open on the
 * project board, or the agent is in the office, is the work rules' rejection
 * to make, not the parser's.
 */
export interface WorkAssignMessage {
  readonly issueNumber: number;
  readonly assigneeId: string;
}

export interface WorkReleaseMessage {
  readonly issueNumber: number;
}

export interface WorkMoveMessage {
  readonly issueNumber: number;
  readonly status: WorkStatus;
}

/**
 * Longest name kept, in code points: what fits on a nameplate. A runner's sync
 * holds a slot name to the same number in bytes instead; see `parseRunnerSync`.
 */
export const MAX_NAME_LENGTH = 18;

/** Long enough for a real summary line, short enough for a board card. */
export const MAX_TITLE_LENGTH = 90;

/** Rejects an id longer than anything the server itself mints. */
const MAX_ID_LENGTH = 64;

/** C0 controls plus DEL, which have no business in a rendered nameplate. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

const WHITESPACE_RUN = /\s+/g;

function isEmote(value: unknown): value is Emote {
  return typeof value === "string" && (EMOTES as readonly string[]).includes(value);
}

function isReportedAnimation(value: unknown): value is ReportedAnimation {
  return value === ANIMATION_STATE.idle || value === ANIMATION_STATE.walking;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Validates a raw `pose` payload.
 *
 * @returns the pose, or `undefined` if the payload is not one. A rejected
 * message is dropped rather than corrected; the sender will send another one a
 * fraction of a second later.
 */
export function parsePoseMessage(raw: unknown): PoseMessage | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const candidate = raw as Partial<Record<keyof PoseMessage, unknown>>;
  if (
    !isFiniteNumber(candidate.x) ||
    !isFiniteNumber(candidate.z) ||
    !isFiniteNumber(candidate.yaw) ||
    !isReportedAnimation(candidate.animation)
  ) {
    return undefined;
  }
  return {
    x: candidate.x,
    z: candidate.z,
    yaw: candidate.yaw,
    animation: candidate.animation,
  };
}

/**
 * Validates a raw `interact` payload.
 *
 * Only the shape is checked here. Whether the named interactable exists, is in
 * reach, or is free is the server's decision, made with `authorizeInteract`
 * against the layout and the sender's authoritative pose.
 *
 * @returns the message, or `undefined` if the payload is not one.
 */
export function parseInteractMessage(raw: unknown): InteractMessage | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const { target } = raw as { target?: unknown };
  return isId(target) ? { target } : undefined;
}

/**
 * Validates a raw `emote` payload.
 *
 * @returns the emote, or `undefined` for anything outside the vocabulary. There
 * is nothing to salvage from an unknown gesture, so it is dropped.
 */
export function parseEmoteMessage(raw: unknown): EmoteMessage | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const candidate = (raw as { emote?: unknown }).emote;
  return isEmote(candidate) ? { emote: candidate } : undefined;
}

/**
 * Reduces a client-supplied chat line to something safe to render.
 *
 * Three things happen here, and all three matter downstream:
 *
 * - **Control characters go.** A newline or a bidi override in a chat line is
 *   either an accident or an attempt to reflow somebody else's HUD.
 * - **Whitespace runs collapse.** The bubble and the log are both single
 *   paragraphs of flowing text; a hundred spaces is not layout, it is padding.
 * - **The result is truncated** to {@link MAX_CHAT_LENGTH}, which is the length
 *   the bubble and the log entry are sized for.
 *
 * What does *not* happen here is escaping. The result is text, and both places
 * it is rendered — a canvas and a React text node — take text rather than
 * markup, so there is no markup context to escape for.
 */
export function sanitizeChatText(raw: unknown): string {
  return sanitizeLine(raw, MAX_CHAT_LENGTH);
}

/**
 * Reduces a note on an issue's work — why an agent is stuck, why the work
 * changed hands — to something safe to render: the chat treatment at
 * {@link MAX_WORK_NOTE_LENGTH}, since a note reads as one flowing line.
 */
export function sanitizeWorkNote(raw: unknown): string {
  return sanitizeLine(raw, MAX_WORK_NOTE_LENGTH);
}

/**
 * Reduces a client-supplied message to the AI manager to something safe to
 * keep and render: the chat treatment, at {@link MAX_MANAGER_MESSAGE_LENGTH}.
 */
export function sanitizeManagerText(raw: unknown): string {
  return sanitizeLine(raw, MAX_MANAGER_MESSAGE_LENGTH);
}

/** Flattens, collapses and truncates by code point; see {@link sanitizeChatText}. */
function sanitizeLine(raw: unknown, maxLength: number): string {
  if (typeof raw !== "string") {
    return "";
  }
  return Array.from(
    raw.replace(CONTROL_CHARACTERS, " ").replace(WHITESPACE_RUN, " ").trim()
  )
    .slice(0, maxLength)
    .join("")
    .trim();
}

/**
 * Validates a raw `chat` payload.
 *
 * @returns the sanitized message, or `undefined` when nothing legible survived
 * sanitization — an empty string, or a line that was only control characters.
 */
export function parseChatMessage(raw: unknown): ChatMessage | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const text = sanitizeChatText((raw as { text?: unknown }).text);
  return text === "" ? undefined : { text };
}

/**
 * Validates a raw `manager:say` payload.
 *
 * Shape only: whether the sender may instruct the manager is the authority
 * rule's call, in `manager.ts`.
 *
 * @returns the sanitized message, or `undefined` when nothing legible survived.
 */
export function parseManagerSayMessage(raw: unknown): ManagerSayMessage | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const text = sanitizeManagerText((raw as { text?: unknown }).text);
  return text === "" ? undefined : { text };
}

/**
 * Validates a raw `operator:verify` payload.
 *
 * The passphrase is taken as sent, not trimmed or stripped: it is compared,
 * never shown, so changing it would only turn a right answer wrong. Only the
 * shape is checked — a string of a length someone could have typed.
 */
export function parseOperatorVerifyMessage(raw: unknown): OperatorVerifyMessage | undefined {
  const candidate = asRecord(raw);
  const passphrase = candidate?.passphrase;
  if (
    typeof passphrase !== "string" ||
    passphrase === "" ||
    passphrase.length > MAX_OPERATOR_PASSPHRASE_LENGTH
  ) {
    return undefined;
  }
  return { passphrase };
}

/**
 * Reduces a client-supplied display name to something safe to render.
 *
 * Collapses whitespace, strips control characters, and truncates. An empty
 * result is the caller's cue to fall back to a generated name.
 */
export function sanitizeName(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }
  return Array.from(
    raw.replace(CONTROL_CHARACTERS, " ").replace(WHITESPACE_RUN, " ").trim()
  )
    .slice(0, MAX_NAME_LENGTH)
    .join("");
}

/** Reads join options off an untrusted payload. */
export function parseJoinOptions(raw: unknown): JoinOptions {
  if (typeof raw !== "object" || raw === null) {
    return {};
  }
  const name = sanitizeName((raw as { name?: unknown }).name);
  return name === "" ? {} : { name };
}

/**
 * Reduces an untrusted title — an issue's, a live agent's task — to one
 * renderable line.
 *
 * Same treatment as a display name, at a card's width: a title is read in a
 * fixed-height row, so a newline in it is a layout bug rather than formatting.
 */
export function sanitizeTitle(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }
  return raw
    .replace(CONTROL_CHARACTERS, " ")
    .replace(WHITESPACE_RUN, " ")
    .trim()
    .slice(0, MAX_TITLE_LENGTH);
}

/** C0 controls and DEL except newline, which a description may legitimately use. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const BODY_CONTROL_CHARACTERS = /[\u0000-\u0009\u000b-\u001f\u007f]/g;

/** Any of the three line endings a browser might send, normalised to one. */
const LINE_BREAK = /\r\n?/g;

/** Three or more newlines, i.e. more blank space than a card will ever show. */
const BLANK_LINE_RUN = /\n{3,}/g;

/**
 * Reduces an untrusted description — an issue's body — to something safe to
 * render, at most `maxLength` characters.
 *
 * Unlike a title this keeps newlines — a description is the place a human
 * writes a list — but collapses a run of them, so a body cannot be padded out
 * to push the rest of a panel off screen.
 */
export function sanitizeBody(raw: unknown, maxLength: number): string {
  return sanitizeParagraphs(raw, maxLength);
}

/**
 * Reduces a line the AI manager posts — a model's reply among them — to
 * something safe to render, keeping its line breaks as a description does.
 */
export function sanitizeManagerReply(raw: unknown): string {
  return sanitizeParagraphs(raw, MAX_MANAGER_REPLY_LENGTH).trim();
}

/** Normalises and caps multi-line text; see {@link sanitizeBody}. */
function sanitizeParagraphs(raw: unknown, maxLength: number): string {
  if (typeof raw !== "string") {
    return "";
  }
  return raw
    .replace(LINE_BREAK, "\n")
    .replace(BODY_CONTROL_CHARACTERS, " ")
    .replace(BLANK_LINE_RUN, "\n\n")
    .trim()
    .slice(0, maxLength);
}

/** Whether a value is usable as an occupant or interactable id. */
function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function asRecord(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : undefined;
}

/** Larger than any issue number GitHub will hand out, and what `uint32` holds. */
const MAX_ISSUE_NUMBER = 0xffffffff;

/** Whether a value is usable as a GitHub issue number: a positive whole number. */
function isIssueNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_ISSUE_NUMBER;
}

/**
 * Longest occupant key a prompt may name: a runner slot's live agent key,
 * `agent:runner:<runner>:<slot>`, with both names at their longest.
 */
const MAX_AGENT_KEY_LENGTH = 96;

/**
 * Everything that is not printable text or a newline: the C0 controls but
 * newline, DEL, the C1 controls, and the invisible marks that reorder text
 * for whoever reads it (`U+200E`, `U+200F`, `U+202A`–`U+202E`,
 * `U+2066`–`U+2069`).
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const PROMPT_CONTROL_CHARACTERS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Reduces a prompt for a coding agent to printable text and newlines.
 *
 * A prompt is typed into a terminal whose program reads every byte as input,
 * so an escape character in it could end the paste it is wrapped in and type
 * whatever follows as keystrokes: control characters go, every one of them,
 * not only the ones that look dangerous today. A tab becomes a space, line
 * endings become `\n`, and the whole is trimmed. Nothing is cut: a prompt
 * longer than {@link MAX_AGENT_PROMPT_LENGTH} is the parser's to refuse.
 */
export function sanitizePromptText(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }
  return raw.replace(LINE_BREAK, "\n").replace(/\t/g, " ").replace(PROMPT_CONTROL_CHARACTERS, "").trim();
}

/**
 * Validates a raw `agent:prompt` payload.
 *
 * Shape only: whether the sender may prompt the agent is `agentPromptRefusal`'s
 * call, and whether the agent is at its prompt is its runner's.
 *
 * @returns the sanitized message, or `undefined` for a malformed one, one with
 * nothing legible left, or one longer than {@link MAX_AGENT_PROMPT_LENGTH}.
 */
export function parseAgentPromptMessage(raw: unknown): AgentPromptMessage | undefined {
  const candidate = asRecord(raw);
  const agentId = candidate?.agentId;
  if (
    candidate === undefined ||
    typeof agentId !== "string" ||
    agentId === "" ||
    agentId.length > MAX_AGENT_KEY_LENGTH ||
    typeof candidate.text !== "string"
  ) {
    return undefined;
  }
  if (candidate.text.replace(LINE_BREAK, "\n").length > MAX_AGENT_PROMPT_LENGTH) {
    return undefined;
  }
  const text = sanitizePromptText(candidate.text);
  return text === "" ? undefined : { agentId, text };
}

/** Validates a raw `work:assign` payload. */
export function parseWorkAssignMessage(raw: unknown): WorkAssignMessage | undefined {
  const candidate = asRecord(raw);
  if (candidate === undefined || !isIssueNumber(candidate.issueNumber) || !isId(candidate.assigneeId)) {
    return undefined;
  }
  return { issueNumber: candidate.issueNumber, assigneeId: candidate.assigneeId };
}

/** Validates a raw `work:release` payload. */
export function parseWorkReleaseMessage(raw: unknown): WorkReleaseMessage | undefined {
  const candidate = asRecord(raw);
  if (candidate === undefined || !isIssueNumber(candidate.issueNumber)) {
    return undefined;
  }
  return { issueNumber: candidate.issueNumber };
}

/**
 * Validates a raw `work:move` payload.
 *
 * Proves the status is one of the four. Whether it is *reachable* from where
 * the work is now is the transition table's call, not the parser's.
 */
export function parseWorkMoveMessage(raw: unknown): WorkMoveMessage | undefined {
  const candidate = asRecord(raw);
  if (candidate === undefined || !isIssueNumber(candidate.issueNumber) || !isWorkStatus(candidate.status)) {
    return undefined;
  }
  return { issueNumber: candidate.issueNumber, status: candidate.status };
}
