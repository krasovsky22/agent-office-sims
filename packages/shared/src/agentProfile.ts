/**
 * A runner's coding agent's profile: the name, title and description it goes
 * by in the office, which its runner also gives the agent as its system prompt.
 *
 * Every agent starts as a person, not a number: a name drawn from
 * {@link DEFAULT_AGENT_NAMES}, the title {@link DEFAULT_AGENT_TITLE} and a
 * one-line description to match. The CEO may change all three, under the same
 * rule as handing an agent work, since the title and description steer what a
 * process on the runner's host does: {@link agentProfileRefusal} is asked by
 * the server for every edit, and by the client only to show the form or say
 * why not. Nothing else sets a profile: no issue, pull request or agent's
 * output reaches it.
 *
 * The runner keeps the profile, so it outlives a restart of either side, and
 * reports it on every sync; an edit reaches it as a command and applies from
 * the agent's next session, since a running one already has its prompt.
 *
 * Each field is capped in the bytes a sync body spends on it, as the runner
 * contract measures every string, so whatever the CEO writes, in any script,
 * the runner reports back whole.
 */

import { MAX_NAME_LENGTH, sanitizeName } from "./messages.js";
import type { OfficeActor } from "./work.js";

/** What every agent's title is until the CEO gives it another. */
export const DEFAULT_AGENT_TITLE = "Software Developer";

/** What every agent's description is until the CEO writes another. */
export const DEFAULT_AGENT_DESCRIPTION =
  "Takes the GitHub issues it is given, implements and tests the change, and opens a pull request for a person to review.";

/**
 * The names a runner's agents start with: short enough for a nameplate, and
 * unlike one another, so the office and the AI Manager can tell them apart.
 * Read in blocks of {@link NAMES_PER_RUNNER}, one block per runner.
 */
export const DEFAULT_AGENT_NAMES = [
  "Maya",
  "Leo",
  "Priya",
  "Omar",
  "Sofia",
  "Kenji",
  "Amara",
  "Lucas",
  "Nadia",
  "Theo",
  "Ines",
  "Ravi",
  "Elena",
  "Kwame",
  "Hana",
  "Mateo",
  "Zara",
  "Felix",
  "Aiko",
  "Diego",
  "Lena",
  "Tariq",
  "Mira",
  "Jonas",
] as const;

/** One runner's block of default names: as many as the floor takes slots from one runner. */
const NAMES_PER_RUNNER = 4;

/** Longest title kept, in the bytes a sync spends on it: a nameplate's second half. */
export const MAX_AGENT_TITLE_BYTES = 40;

/** Longest description kept, in the bytes a sync spends on it: a paragraph or two of a role. */
export const MAX_AGENT_DESCRIPTION_BYTES = 400;

export interface AgentProfile {
  readonly name: string;
  readonly title: string;
  readonly description: string;
}

/** Why an edit to an agent's profile was not made. Refusal changes nothing. */
export const AGENT_PROFILE_REJECTION = {
  /** Only the CEO edits the agents' profiles. */
  forbidden: "forbidden",
  /** Not a runner's coding agent in the office, or no longer here. */
  noAgent: "no-agent",
  /** Its runner could not be given the edit: gone silent, or too much waiting for it. */
  offline: "offline",
} as const;

export type AgentProfileRejection = (typeof AGENT_PROFILE_REJECTION)[keyof typeof AGENT_PROFILE_REJECTION];

/**
 * Whether an actor may edit a coding agent's profile, and if not, why. **The one gate.**
 *
 * @returns `undefined` when they may, else the rejection to send them.
 */
export function agentProfileRefusal(actor: OfficeActor): AgentProfileRejection | undefined {
  return actor.isCeo ? undefined : AGENT_PROFILE_REJECTION.forbidden;
}

/**
 * The bytes a string takes in a JSON body as `JSON.stringify` writes it: its
 * UTF-8, with JSON's escapes and without the quotes. The unit every string
 * budget in the runner contract is measured in.
 */
export function jsonTextBytes(value: string): number {
  let bytes = 0;
  for (const character of JSON.stringify(value).slice(1, -1)) {
    const code = character.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** Cuts a string to a byte budget, as {@link jsonTextBytes} measures it, whole characters at a time. */
export function fitJsonBytes(value: string, maxBytes: number): string {
  if (jsonTextBytes(value) <= maxBytes) {
    return value;
  }
  let used = 0;
  let end = 0;
  for (const character of value) {
    used += jsonTextBytes(character);
    if (used > maxBytes) {
      break;
    }
    end += character.length;
  }
  return value.slice(0, end);
}

// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/** Every control character but newline, and the invisible marks that reorder text. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const DESCRIPTION_CONTROL_CHARACTERS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/** A name for a nameplate: a display name's treatment, within its budget in bytes too. */
export function sanitizeAgentName(raw: unknown): string {
  return fitJsonBytes(sanitizeName(raw), MAX_NAME_LENGTH).trim();
}

/** A title: one line, whitespace collapsed, within {@link MAX_AGENT_TITLE_BYTES}. */
export function sanitizeAgentTitle(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }
  return fitJsonBytes(raw.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim(), MAX_AGENT_TITLE_BYTES).trim();
}

/**
 * A description: a system prompt's text, so printable characters and line
 * breaks only, blank runs collapsed to one empty line, within
 * {@link MAX_AGENT_DESCRIPTION_BYTES}.
 */
export function sanitizeAgentDescription(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }
  const text = raw
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(DESCRIPTION_CONTROL_CHARACTERS, "")
    .replace(/[ ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return fitJsonBytes(text, MAX_AGENT_DESCRIPTION_BYTES).trim();
}

/**
 * Proves a profile's shape and sanitises it.
 *
 * @returns the profile, or `undefined` when its name or title is left empty;
 * a description may be.
 */
export function parseAgentProfile(raw: unknown): AgentProfile | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const candidate = raw as Record<string, unknown>;
  const name = sanitizeAgentName(candidate["name"]);
  const title = sanitizeAgentTitle(candidate["title"]);
  if (name === "" || title === "") {
    return undefined;
  }
  return { name, title, description: sanitizeAgentDescription(candidate["description"]) };
}

/**
 * A small, stable hash, FNV-1a with a final mix, so a runner's agents start at
 * the same place in the names every time, and runners whose ids differ by a
 * character, `runner-1` and `runner-2`, most likely do not.
 */
function hashOf(text: string): number {
  let hash = 0x811c9dc5;
  for (const character of text) {
    hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 0x01000193) >>> 0;
  }
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35) >>> 0;
  return (hash ^ (hash >>> 16)) >>> 0;
}

/**
 * The name a runner's slot starts with: a block of
 * {@link DEFAULT_AGENT_NAMES} picked by the runner's id, then one name on per
 * slot, so a runner's agents never share one and keep theirs across restarts,
 * and a second runner most likely has a block of its own.
 */
export function defaultAgentName(runnerId: string, index: number): string {
  const names = DEFAULT_AGENT_NAMES;
  const blocks = Math.floor(names.length / NAMES_PER_RUNNER);
  const start = (hashOf(runnerId) % blocks) * NAMES_PER_RUNNER;
  return names[(start + index) % names.length] ?? names[0];
}

/** The profile a runner's slot has until the CEO edits it. */
export function defaultAgentProfile(runnerId: string, index: number): AgentProfile {
  return { name: defaultAgentName(runnerId, index), title: DEFAULT_AGENT_TITLE, description: DEFAULT_AGENT_DESCRIPTION };
}

/** How an agent is labelled where there is room for one line: `Maya · Software Developer`. */
export function agentLabel(name: string, title: string): string {
  return title === "" ? name : `${name} · ${title}`;
}
