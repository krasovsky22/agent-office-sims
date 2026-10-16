/**
 * The runner link's wire contract: what an agent runner sends the server on
 * every sync, and the commands the server hands back.
 *
 * The runner is the separate process that owns real coding agents. It is
 * trusted with a secret, not with its payloads: a sync body arrives over HTTP
 * from a process nobody in the office controls, so {@link parseRunnerSync}
 * proves its shape, sanitises every string and refuses any string or list past
 * its cap before the server keeps any of it, exactly as a live agent's report is
 * treated. A command is built only by {@link toRunnerCommand}, which applies
 * the same treatment, so what the server sends is as bounded as what it takes.
 *
 * Shared because the shape is the contract the runner is written against.
 */

import { MAX_WORK_NOTE_LENGTH } from "./constants.js";
import { MAX_TASK_URL_LENGTH, parseTaskUrl } from "./liveAgents.js";
import {
  MAX_NAME_LENGTH,
  MAX_TITLE_LENGTH,
  sanitizeBody,
  sanitizeManagerText,
  sanitizeName,
  sanitizeTitle,
  sanitizeWorkNote,
} from "./messages.js";

/** The route a runner syncs through, on the game server. */
export const RUNNER_SYNC_PATH = "/agents/runner/sync";

/** What one of a runner's slots is doing. */
export const RUNNER_SLOT_STATUS = {
  idle: "idle",
  starting: "starting",
  working: "working",
  /** Waiting on a person: a permission, a question, a sign-in. */
  needsInput: "needs-input",
  exited: "exited",
} as const;

export type RunnerSlotStatus = (typeof RUNNER_SLOT_STATUS)[keyof typeof RUNNER_SLOT_STATUS];

/** What happened to a slot's work, once. */
export const RUNNER_EVENT_KIND = {
  started: "started",
  prOpened: "pr-opened",
  failed: "failed",
  finished: "finished",
} as const;

export type RunnerEventKind = (typeof RUNNER_EVENT_KIND)[keyof typeof RUNNER_EVENT_KIND];

/** What the server may ask of a slot. */
export const RUNNER_COMMAND_KIND = {
  start: "start",
  stop: "stop",
  prompt: "prompt",
} as const;

export type RunnerCommandKind = (typeof RUNNER_COMMAND_KIND)[keyof typeof RUNNER_COMMAND_KIND];

/** A pull request a slot's agent opened. */
export interface RunnerPullRequest {
  readonly number: number;
  /** Sanitised to one line; `""` when the runner did not say. */
  readonly title: string;
  /** Always `https:`. */
  readonly url: string;
}

/** One slot, as the runner reports it on every sync. */
export interface RunnerSlotReport {
  readonly id: string;
  /** Falls back to the id when the runner names nobody. */
  readonly name: string;
  readonly status: RunnerSlotStatus;
  readonly issueNumber: number | undefined;
  /** What the agent is doing right now, e.g. `Bash: pnpm test`; `""` when unknown. */
  readonly activity: string;
  readonly pr: RunnerPullRequest | undefined;
}

/** Something that happened in a slot, reported until a sync carrying it succeeds. */
export interface RunnerEvent {
  /** The runner's own id for it; the server ignores one it has already taken. */
  readonly id: string;
  readonly kind: RunnerEventKind;
  readonly slotId: string;
  readonly issueNumber: number;
  readonly pr: RunnerPullRequest | undefined;
  /** Why it failed, say; `""` when there is nothing to add. */
  readonly message: string;
}

/**
 * One sync: the runner's whole state, the commands it has taken, and what has
 * happened since its last successful sync.
 *
 * Every sync is also a heartbeat. A runner the server has not heard from for
 * the live agents' timeout has its slots taken off the floor.
 */
export interface RunnerSync {
  readonly runnerId: string;
  /** `owner/name`; the server refuses a runner working on any other repository. */
  readonly repo: string;
  /** Ids of commands the runner has taken; none of them is sent again. */
  readonly acked: readonly string[];
  readonly slots: readonly RunnerSlotReport[];
  readonly events: readonly RunnerEvent[];
}

/** Put an agent to work on an issue. */
export interface RunnerStartCommand {
  readonly id: string;
  readonly slotId: string;
  readonly kind: typeof RUNNER_COMMAND_KIND.start;
  readonly issueNumber: number;
  readonly title: string;
  readonly url: string;
  /** The CEO's words, for the agent. */
  readonly note: string;
  /** The CEO who asked, by name. */
  readonly requestedBy: string;
}

/** Stop whatever the slot is doing. */
export interface RunnerStopCommand {
  readonly id: string;
  readonly slotId: string;
  readonly kind: typeof RUNNER_COMMAND_KIND.stop;
  readonly reason: string;
}

/** Say something to the slot's agent. */
export interface RunnerPromptCommand {
  readonly id: string;
  readonly slotId: string;
  readonly kind: typeof RUNNER_COMMAND_KIND.prompt;
  readonly text: string;
  readonly requestedBy: string;
}

export type RunnerCommand = RunnerStartCommand | RunnerStopCommand | RunnerPromptCommand;

/** A command before the server has given it an id. */
export type RunnerCommandDraft =
  | Omit<RunnerStartCommand, "id">
  | Omit<RunnerStopCommand, "id">
  | Omit<RunnerPromptCommand, "id">;

/** The server's reply to a sync: every command the runner has not yet acked. */
export interface RunnerSyncReply {
  readonly ok: true;
  readonly commands: readonly RunnerCommand[];
}

/**
 * Most slots one runner may report, and most on the floor at once across
 * every runner: one number, so a sync the parser takes is never too many for
 * the floor on its own. With the live agents' dozen, still fewer than the open
 * floor's twenty chairs.
 */
export const MAX_RUNNER_SLOTS = 4;

/** Most events one sync may carry. */
export const MAX_RUNNER_EVENTS = 8;

/** Most command ids one sync may ack. */
export const MAX_RUNNER_ACKS = 32;

/** Longest prompt the server will send; it is the one multi-line string here. */
export const MAX_RUNNER_PROMPT_LENGTH = 2000;

/** A runner's or a slot's id: narrow, since it becomes part of a live agent's id. */
const RUNNER_NAME = /^[A-Za-z0-9._-]{1,32}$/;

/** A command's or an event's id. */
const RUNNER_ITEM_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/** `owner/name`, in the characters GitHub allows in each. */
const REPOSITORY = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/** Larger than any issue number GitHub will hand out, and what `uint32` holds. */
const MAX_ISSUE_NUMBER = 0xffffffff;

const SLOT_STATUSES: ReadonlySet<string> = new Set(Object.values(RUNNER_SLOT_STATUS));
const EVENT_KINDS: ReadonlySet<string> = new Set(Object.values(RUNNER_EVENT_KIND));

function asRecord(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
}

function isRunnerName(value: unknown): value is string {
  return typeof value === "string" && RUNNER_NAME.test(value);
}

function isItemId(value: unknown): value is string {
  return typeof value === "string" && RUNNER_ITEM_ID.test(value);
}

function isIssueNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_ISSUE_NUMBER;
}

function isSlotStatus(value: unknown): value is RunnerSlotStatus {
  return typeof value === "string" && SLOT_STATUSES.has(value);
}

function isEventKind(value: unknown): value is RunnerEventKind {
  return typeof value === "string" && EVENT_KINDS.has(value);
}

/**
 * The bytes a string takes in a JSON body as `JSON.stringify` writes it: its
 * UTF-8, with JSON's escapes and without the quotes.
 */
function encodedBytes(value: string): number {
  let bytes = 0;
  for (const character of JSON.stringify(value).slice(1, -1)) {
    const code = character.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * Reads an optional string, refusing one past its budget rather than cutting
 * it. The budget is in {@link encodedBytes}, not characters: the caps on every
 * string and list are what bound a sync's size, and measuring in the body's
 * own unit keeps a sync the parser takes inside the route's body limit
 * whatever characters it holds.
 *
 * @returns the sanitised string, `""` when absent, or `undefined` when refused.
 */
function parseText(raw: unknown, maxBytes: number, sanitize: (raw: string) => string): string | undefined {
  if (raw === undefined || raw === null) {
    return "";
  }
  return typeof raw === "string" && encodedBytes(raw) <= maxBytes ? sanitize(raw) : undefined;
}

/**
 * Parses an optional list, refusing one past its cap rather than reading part
 * of it: a runner that sends more than the contract allows is broken, and
 * quietly dropping its tail would lose events it believes were delivered.
 */
function parseList<T>(raw: unknown, max: number, parse: (item: unknown) => T | undefined): T[] | undefined {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw) || raw.length > max) {
    return undefined;
  }
  const parsed: T[] = [];
  for (const item of raw) {
    const value = parse(item);
    if (value === undefined) {
      return undefined;
    }
    parsed.push(value);
  }
  return parsed;
}

/** `undefined` for an absent pull request, `null` for one that is present and unacceptable. */
function parsePullRequest(raw: unknown): RunnerPullRequest | undefined | null {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const candidate = asRecord(raw);
  if (candidate === undefined || !isIssueNumber(candidate["number"])) {
    return null;
  }
  const rawUrl = parseText(candidate["url"], MAX_TASK_URL_LENGTH, (text) => text);
  const url = rawUrl === undefined ? undefined : parseTaskUrl(rawUrl);
  const title = parseText(candidate["title"], MAX_TITLE_LENGTH, sanitizeTitle);
  if (url === undefined || url === "" || title === undefined) {
    return null;
  }
  return { number: candidate["number"], title, url };
}

function parseSlot(raw: unknown): RunnerSlotReport | undefined {
  const candidate = asRecord(raw);
  if (candidate === undefined) {
    return undefined;
  }
  const { id, status, issueNumber } = candidate;
  if (!isRunnerName(id) || !isSlotStatus(status)) {
    return undefined;
  }
  if (issueNumber !== undefined && issueNumber !== null && !isIssueNumber(issueNumber)) {
    return undefined;
  }
  const pr = parsePullRequest(candidate["pr"]);
  const name = parseText(candidate["name"], MAX_NAME_LENGTH, sanitizeName);
  const activity = parseText(candidate["activity"], MAX_TITLE_LENGTH, sanitizeTitle);
  if (pr === null || name === undefined || activity === undefined) {
    return undefined;
  }
  return {
    id,
    name: name === "" ? sanitizeName(id) : name,
    status,
    issueNumber: isIssueNumber(issueNumber) ? issueNumber : undefined,
    activity,
    pr,
  };
}

function parseEvent(raw: unknown): RunnerEvent | undefined {
  const candidate = asRecord(raw);
  if (candidate === undefined) {
    return undefined;
  }
  const { id, kind, slotId, issueNumber } = candidate;
  if (!isItemId(id) || !isEventKind(kind) || !isRunnerName(slotId) || !isIssueNumber(issueNumber)) {
    return undefined;
  }
  const pr = parsePullRequest(candidate["pr"]);
  const message = parseText(candidate["message"], MAX_WORK_NOTE_LENGTH, sanitizeWorkNote);
  if (pr === null || message === undefined) {
    return undefined;
  }
  return { id, kind, slotId, issueNumber, pr, message };
}

/**
 * Validates a raw sync body.
 *
 * Refuses the whole body for any malformed part, any list past its cap, any
 * string past its budget in bytes, or a slot id reported twice; the runner sends its whole state again a second
 * later, so nothing is lost by refusing and nothing half-read is kept.
 *
 * @returns the sync, or `undefined` if the payload is not one.
 */
export function parseRunnerSync(raw: unknown): RunnerSync | undefined {
  const candidate = asRecord(raw);
  if (candidate === undefined) {
    return undefined;
  }
  const { runnerId, repo } = candidate;
  if (!isRunnerName(runnerId) || typeof repo !== "string" || !REPOSITORY.test(repo)) {
    return undefined;
  }
  const acked = parseList(candidate["acked"], MAX_RUNNER_ACKS, (item) => (isItemId(item) ? item : undefined));
  const slots = parseList(candidate["slots"], MAX_RUNNER_SLOTS, parseSlot);
  const events = parseList(candidate["events"], MAX_RUNNER_EVENTS, parseEvent);
  if (acked === undefined || slots === undefined || events === undefined) {
    return undefined;
  }
  if (new Set(slots.map((slot) => slot.id)).size !== slots.length) {
    return undefined;
  }
  return { runnerId, repo, acked, slots, events };
}

/**
 * Gives a command its id and sanitises every string in it, the same way a
 * sync's are.
 *
 * @returns the command, or `undefined` for a slot id, issue number or link the
 * runner could not act on.
 */
export function toRunnerCommand(id: string, draft: RunnerCommandDraft): RunnerCommand | undefined {
  if (!isItemId(id) || !isRunnerName(draft.slotId)) {
    return undefined;
  }
  switch (draft.kind) {
    case RUNNER_COMMAND_KIND.start: {
      const url = parseTaskUrl(draft.url);
      const title = sanitizeTitle(draft.title);
      if (!isIssueNumber(draft.issueNumber) || url === undefined || url === "" || title === "") {
        return undefined;
      }
      return {
        id,
        slotId: draft.slotId,
        kind: draft.kind,
        issueNumber: draft.issueNumber,
        title,
        url,
        note: sanitizeManagerText(draft.note),
        requestedBy: sanitizeName(draft.requestedBy),
      };
    }
    case RUNNER_COMMAND_KIND.stop:
      return { id, slotId: draft.slotId, kind: draft.kind, reason: sanitizeWorkNote(draft.reason) };
    case RUNNER_COMMAND_KIND.prompt: {
      const text = sanitizeBody(draft.text, MAX_RUNNER_PROMPT_LENGTH);
      if (text === "") {
        return undefined;
      }
      return { id, slotId: draft.slotId, kind: draft.kind, text, requestedBy: sanitizeName(draft.requestedBy) };
    }
  }
}
