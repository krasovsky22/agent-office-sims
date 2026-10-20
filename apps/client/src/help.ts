/**
 * Every control in the office, for the help overlay, and whether this browser
 * has been shown it yet.
 *
 * A newcomer arrives on the pavement with no idea the mouse has to be captured
 * to look around, so the overlay opens by itself on a first visit and after
 * that only on `H`. Like the name, the "seen" mark lives in the browser's
 * storage; storage that is missing or refused just means the overlay opens
 * again next time.
 */

/** Where the browser remembers that it has shown the help overlay. */
export const HELP_SEEN_STORAGE_KEY = "agent-office-sims.helpSeen";

/** Opens and closes the help overlay. Named in the HUD as `H`. */
export const HELP_KEY = "KeyH";

export interface Control {
  readonly keys: string;
  readonly action: string;
}

/** What each key and the mouse do, in the order a newcomer needs them. */
export const CONTROLS: readonly Control[] = [
  { keys: "W A S D", action: "Walk (the arrow keys work too)" },
  { keys: "Click", action: "Capture the mouse; move it to look around" },
  { keys: "Esc", action: "Free the mouse to click the HUD, or close a panel" },
  { keys: "E", action: "Use what you are standing by — a chair, a board, the radio; hold it by an agent for its menu" },
  { keys: "Space", action: "Jump" },
  { keys: "V", action: "Switch between third and first person" },
  { keys: "Wheel", action: "Zoom the camera in third person, or scroll a panel" },
  { keys: "Enter", action: "Chat" },
  { keys: "1–5", action: "Wave, laugh, shrug, point, thumbs up" },
  { keys: "/", action: "Search the project board, when it is open" },
  { keys: "PgUp PgDn", action: "Scroll an agent's terminal" },
  { keys: "H", action: "Show or hide this help" },
];

/** Whether this browser has shown the help overlay before. */
export function helpSeen(storage: Pick<Storage, "getItem"> | undefined): boolean {
  try {
    return storage?.getItem(HELP_SEEN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Remembers that the help overlay has been shown, if the browser lets it. */
export function markHelpSeen(storage: Pick<Storage, "setItem"> | undefined): void {
  try {
    storage?.setItem(HELP_SEEN_STORAGE_KEY, "1");
  } catch {
    // Not kept: the overlay opens again on the next visit, which costs a click.
  }
}
