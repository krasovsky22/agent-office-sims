/**
 * Client -> server commands.
 *
 * Everything crossing this boundary arrives as `unknown` from a browser nobody
 * controls, so each message type ships with the parser that proves a payload is
 * one. The server never reads a field off a raw message directly.
 */

import {
  ANIMATION_STATE,
  type AnimationState,
  type TicketStatus,
  isTicketStatus,
} from "./state.js";

/** Matchmaking name of the only room type this milestone defines. */
export const OFFICE_ROOM_NAME = "office";

export const CLIENT_MESSAGE = {
  /** The client's own pose, sent on a fixed interval while it is connected. */
  pose: "pose",
  /** File a new ticket into the backlog. */
  ticketCreate: "ticket:create",
  /** Give a ticket an owner, taking it out of the backlog if it is in one. */
  ticketAssign: "ticket:assign",
  /** Drop a ticket's owner, returning it to the backlog. */
  ticketUnassign: "ticket:unassign",
  /** Move a ticket to an adjacent status. */
  ticketMoveStatus: "ticket:move-status",
  /** Rewrite a ticket's title, body, or both. */
  ticketEdit: "ticket:edit",
} as const;

export type ClientMessageType = (typeof CLIENT_MESSAGE)[keyof typeof CLIENT_MESSAGE];

/** Where the sending client believes it is, in world units. */
export interface PoseMessage {
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly animation: AnimationState;
}

/** Options a client may supply when joining the office room. */
export interface JoinOptions {
  readonly name?: string;
}

/**
 * The five ticket commands.
 *
 * Each parser below returns the payload with its strings already sanitised, so
 * a handler that has a payload has text it can replicate. The id fields are
 * passed through as-is: an id the board does not know is the applier's
 * rejection to make, not the parser's.
 */
export interface TicketCreateMessage {
  readonly title: string;
  readonly body: string;
}

export interface TicketAssignMessage {
  readonly ticketId: string;
  readonly assigneeId: string;
}

export interface TicketUnassignMessage {
  readonly ticketId: string;
}

export interface TicketMoveStatusMessage {
  readonly ticketId: string;
  readonly status: TicketStatus;
}

/** An edit omits whatever it is not changing. At least one field is present. */
export interface TicketEditMessage {
  readonly ticketId: string;
  readonly title?: string;
  readonly body?: string;
}

const MAX_NAME_LENGTH = 18;

/** Long enough for a real summary line, short enough for a board card. */
const MAX_TICKET_TITLE_LENGTH = 90;

/** Long enough for the detail an agent would need to act on the ticket. */
const MAX_TICKET_BODY_LENGTH = 1200;

/** Rejects an id longer than anything the server itself mints. */
const MAX_ID_LENGTH = 64;

/** C0 controls plus DEL, which have no business in a rendered nameplate. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

const WHITESPACE_RUN = /\s+/g;

function isAnimationState(value: unknown): value is AnimationState {
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

/**
 * Reduces a client-supplied ticket title to one renderable line.
 *
 * Same treatment as a display name, at a card's width: a title is read in a
 * fixed-height row, so a newline in it is a layout bug rather than formatting.
 */
export function sanitizeTicketTitle(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }
  return raw
    .replace(CONTROL_CHARACTERS, " ")
    .replace(WHITESPACE_RUN, " ")
    .trim()
    .slice(0, MAX_TICKET_TITLE_LENGTH);
}

/** C0 controls and DEL except newline, which a ticket body may legitimately use. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const BODY_CONTROL_CHARACTERS = /[\u0000-\u0009\u000b-\u001f\u007f]/g;

/** Any of the three line endings a browser might send, normalised to one. */
const LINE_BREAK = /\r\n?/g;

/** Three or more newlines, i.e. more blank space than a card will ever show. */
const BLANK_LINE_RUN = /\n{3,}/g;

/**
 * Reduces a client-supplied ticket body to something safe to render.
 *
 * Unlike a title this keeps newlines — a ticket body is the place a human
 * writes a list — but collapses a run of them, so a body cannot be padded out
 * to push the rest of a panel off screen.
 */
export function sanitizeTicketBody(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }
  return raw
    .replace(LINE_BREAK, "\n")
    .replace(BODY_CONTROL_CHARACTERS, " ")
    .replace(BLANK_LINE_RUN, "\n\n")
    .trim()
    .slice(0, MAX_TICKET_BODY_LENGTH);
}

/** Whether a value is usable as an occupant or ticket id. */
function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function asRecord(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : undefined;
}

/**
 * Validates a raw `ticket:create` payload.
 *
 * A ticket with no title after sanitising is not a ticket, so it is rejected
 * here rather than filed as an untitled card. An empty body is allowed: "fix
 * the login loop" is sometimes the whole brief.
 */
export function parseTicketCreateMessage(raw: unknown): TicketCreateMessage | undefined {
  const candidate = asRecord(raw);
  if (candidate === undefined) {
    return undefined;
  }
  const title = sanitizeTicketTitle(candidate.title);
  if (title === "") {
    return undefined;
  }
  return { title, body: sanitizeTicketBody(candidate.body) };
}

/** Validates a raw `ticket:assign` payload. */
export function parseTicketAssignMessage(raw: unknown): TicketAssignMessage | undefined {
  const candidate = asRecord(raw);
  if (candidate === undefined || !isId(candidate.ticketId) || !isId(candidate.assigneeId)) {
    return undefined;
  }
  return { ticketId: candidate.ticketId, assigneeId: candidate.assigneeId };
}

/** Validates a raw `ticket:unassign` payload. */
export function parseTicketUnassignMessage(raw: unknown): TicketUnassignMessage | undefined {
  const candidate = asRecord(raw);
  if (candidate === undefined || !isId(candidate.ticketId)) {
    return undefined;
  }
  return { ticketId: candidate.ticketId };
}

/**
 * Validates a raw `ticket:move-status` payload.
 *
 * Proves the status is one of the five. Whether it is *reachable* from where
 * the ticket is now is the transition table's call, not the parser's.
 */
export function parseTicketMoveStatusMessage(raw: unknown): TicketMoveStatusMessage | undefined {
  const candidate = asRecord(raw);
  if (candidate === undefined || !isId(candidate.ticketId) || !isTicketStatus(candidate.status)) {
    return undefined;
  }
  return { ticketId: candidate.ticketId, status: candidate.status };
}

/**
 * Validates a raw `ticket:edit` payload.
 *
 * An absent field means "leave it alone", so a payload naming neither field is
 * not an edit and is rejected. A present-but-blank title is rejected for the
 * same reason `create` rejects one; a present-but-blank body is a real edit,
 * since clearing a body someone no longer wants is a sensible thing to do.
 */
export function parseTicketEditMessage(raw: unknown): TicketEditMessage | undefined {
  const candidate = asRecord(raw);
  if (candidate === undefined || !isId(candidate.ticketId)) {
    return undefined;
  }

  const hasTitle = candidate.title !== undefined;
  const hasBody = candidate.body !== undefined;
  if (!hasTitle && !hasBody) {
    return undefined;
  }

  const title = hasTitle ? sanitizeTicketTitle(candidate.title) : undefined;
  if (hasTitle && title === "") {
    return undefined;
  }

  return {
    ticketId: candidate.ticketId,
    ...(title === undefined ? {} : { title }),
    ...(hasBody ? { body: sanitizeTicketBody(candidate.body) } : {}),
  };
}
