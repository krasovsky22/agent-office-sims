/**
 * The name the arrival card offers, and what the HUD says when the office
 * refuses one.
 *
 * `?name=` wins, so a link or a second tab can still say who it is; otherwise
 * the card offers the name this browser chose last, kept in its storage rather
 * than sent anywhere. Storage that is missing or refused is not an error: the
 * card just starts empty.
 */

import { NAME_REJECTION, type NameRejectedEvent, sanitizeName } from "@sim/shared";

/** Where the last chosen name is kept in the browser's storage. */
export const PLAYER_NAME_STORAGE_KEY = "agent-office-sims.playerName";

/** The arrival card's prefill: `?name=` from `search`, else the stored name, else `""`. */
export function readPlayerName(search: string, storage: Pick<Storage, "getItem"> | undefined): string {
  const requested = sanitizeName(new URLSearchParams(search).get("name"));
  if (requested !== "") {
    return requested;
  }
  try {
    return sanitizeName(storage?.getItem(PLAYER_NAME_STORAGE_KEY));
  } catch {
    return "";
  }
}

/** Keeps the chosen name for next time, if the browser lets it be kept. */
export function writePlayerName(storage: Pick<Storage, "setItem"> | undefined, name: string): void {
  try {
    storage?.setItem(PLAYER_NAME_STORAGE_KEY, sanitizeName(name));
  } catch {
    // Not kept: the next visit's card starts empty, which is no worse than before.
  }
}

/**
 * Keeps the name the player asked for once the office has given it to them:
 * `current` is the name they hold now, so a refused name, a numbered variant
 * or a generated `Guest N` is never kept.
 *
 * @returns whether `asked` was accepted, and so kept.
 */
export function keepAcceptedName(storage: Pick<Storage, "setItem"> | undefined, asked: string, current: string | undefined): boolean {
  if (current === undefined || sanitizeName(asked) !== current) {
    return false;
  }
  writePlayerName(storage, current);
  return true;
}

/** Why the office refused `event.name`, and what the player is called instead when that is known. */
export function nameRejectionText(event: NameRejectedEvent, current: string | undefined): string {
  const reason =
    event.rejection === NAME_REJECTION.taken
      ? `Someone here is already called ${event.name}.`
      : `${event.name} is the name of someone who works here.`;
  return current === undefined ? reason : `${reason} You are ${current}; rename yourself from the roster.`;
}
