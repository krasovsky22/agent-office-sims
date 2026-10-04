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

import { MAX_CHAT_LENGTH } from "./constants.js";
import { ANIMATION_STATE, type AnimationState } from "./state.js";

/** Matchmaking name of the only room type this milestone defines. */
export const OFFICE_ROOM_NAME = "office";

export const CLIENT_MESSAGE = {
  /** The client's own pose, sent on a fixed interval while it is connected. */
  pose: "pose",
  /** A gesture from the fixed {@link EMOTE} vocabulary. */
  emote: "emote",
  /** A line of text chat. */
  chat: "chat",
} as const;

export type ClientMessageType = (typeof CLIENT_MESSAGE)[keyof typeof CLIENT_MESSAGE];

export const SERVER_MESSAGE = {
  /** An occupant emoted; every client in the room draws it. */
  emote: "emote",
  /** An occupant said something; every client in the room draws and logs it. */
  chat: "chat",
  /** Sent only to the client whose message was dropped by a rate limit. */
  throttled: "throttled",
} as const;

export type ServerMessageType = (typeof SERVER_MESSAGE)[keyof typeof SERVER_MESSAGE];

/**
 * The gestures an occupant can perform.
 *
 * A closed vocabulary rather than free text: every value here has to have a
 * sprite drawn for it, and a client cannot invent a sixth one. Agent employees
 * will emote from this same set.
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
  readonly animation: AnimationState;
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
  readonly command: typeof CLIENT_MESSAGE.emote | typeof CLIENT_MESSAGE.chat;
}

/** Options a client may supply when joining the office room. */
export interface JoinOptions {
  readonly name?: string;
}

const MAX_NAME_LENGTH = 18;

/** C0 controls plus DEL, which have no business in a rendered nameplate. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

const WHITESPACE_RUN = /\s+/g;

function isAnimationState(value: unknown): value is AnimationState {
  return value === ANIMATION_STATE.idle || value === ANIMATION_STATE.walking;
}

function isEmote(value: unknown): value is Emote {
  return typeof value === "string" && (EMOTES as readonly string[]).includes(value);
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
    !isAnimationState(candidate.animation)
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
  if (typeof raw !== "string") {
    return "";
  }
  return raw
    .replace(CONTROL_CHARACTERS, " ")
    .replace(WHITESPACE_RUN, " ")
    .trim()
    .slice(0, MAX_CHAT_LENGTH)
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
 * Reduces a client-supplied display name to something safe to render.
 *
 * Collapses whitespace, strips control characters, and truncates. An empty
 * result is the caller's cue to fall back to a generated name.
 */
export function sanitizeName(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }
  return raw
    .replace(CONTROL_CHARACTERS, " ")
    .replace(WHITESPACE_RUN, " ")
    .trim()
    .slice(0, MAX_NAME_LENGTH);
}

/** Reads join options off an untrusted payload. */
export function parseJoinOptions(raw: unknown): JoinOptions {
  if (typeof raw !== "object" || raw === null) {
    return {};
  }
  const name = sanitizeName((raw as { name?: unknown }).name);
  return name === "" ? {} : { name };
}
