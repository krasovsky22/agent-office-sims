/**
 * Client -> server commands.
 *
 * Everything crossing this boundary arrives as `unknown` from a browser nobody
 * controls, so each message type ships with the parser that proves a payload is
 * one. The server never reads a field off a raw message directly.
 */

import { ANIMATION_STATE, type ReportedAnimation } from "./state.js";

/** Matchmaking name of the only room type this milestone defines. */
export const OFFICE_ROOM_NAME = "office";

export const CLIENT_MESSAGE = {
  /** The client's own pose, sent on a fixed interval while it is connected. */
  pose: "pose",
  /** A request to use a named interactable the sender believes it is next to. */
  interact: "interact",
  /** A request to stop using whatever the sender is currently engaged with. */
  release: "release",
} as const;

export type ClientMessageType = (typeof CLIENT_MESSAGE)[keyof typeof CLIENT_MESSAGE];

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

/** Options a client may supply when joining the office room. */
export interface JoinOptions {
  readonly name?: string;
}

const MAX_NAME_LENGTH = 18;

/** C0 controls plus DEL, which have no business in a rendered nameplate. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

const WHITESPACE_RUN = /\s+/g;

/** Longest interactable id the parser will carry; comfortably over the real ones. */
const MAX_TARGET_LENGTH = 64;

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
  if (typeof target !== "string" || target === "" || target.length > MAX_TARGET_LENGTH) {
    return undefined;
  }
  return { target };
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
