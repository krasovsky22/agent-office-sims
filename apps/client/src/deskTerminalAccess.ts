/**
 * What the local player's desk shows them while they sit at a computer, in
 * words the HUD can show.
 *
 * Nothing is decided here. The server lends each player's desks a coding
 * agent (`desks` in the replicated state, one `DeskTerminal` per desk that is
 * on) and this module only reads those records for the local player: a desk
 * of theirs they sit at opens the terminal panel on its own lent agent's terminal,
 * with a line saying why there is no terminal yet when there is none, and again
 * on the same session each time they sit back down there, since each keeps
 * running until they turn it off; sitting at a computer someone else has on
 * tells them whose it is, since that session is theirs alone. Like
 * `agentPromptAccess.ts` for the panel's composer.
 */

import { type AgentPromptEntry, DESK_TERMINAL_PHASE, type DeskTerminal } from "@sim/shared";

/** The replicated desk terminal, as this module reads it. */
export type DeskReading = Pick<DeskTerminal, "seatId" | "ownerId" | "agentId" | "phase" | "needsInput" | "activity" | "note">;

/** Every desk that is on, by seat id, as this module reads the replicated map. */
export interface DeskReadings {
  get(seatId: string): DeskReading | undefined;
  values(): Iterable<DeskReading>;
}

/** What a player's desk panel shows. */
export interface DeskPanelView {
  /** The desk's seat, which its Turn off button names. */
  readonly seatId: string;
  /** The lent agent's occupant key, whose terminal it is; `""` while there is none. */
  readonly agentId: string;
  /** Why there is no terminal to prompt, or `""` while there is one. */
  readonly message: string;
  /** The session waits on a choice on its screen: the key pad, not the composer. */
  readonly needsInput: boolean;
  /** What its agent is doing. */
  readonly activity: string;
  /** The last prompt entry id from before the computer was turned on, so the panel shows only its session's prompts. */
  readonly promptsAfter: number;
}

/**
 * The local player's desk panel, or `undefined` when they sit at no desk
 * the server has lent an agent to for them.
 *
 * @param heldWith the interactable the local player is predicted to hold, `""` for none.
 * @param promptsAfter the last prompt entry id from before that desk's computer was turned on.
 */
export function deskPanelFor(
  desks: DeskReadings | undefined,
  localId: string,
  heldWith: string,
  promptsAfter: number,
): DeskPanelView | undefined {
  const desk = heldWith === "" ? undefined : desks?.get(heldWith);
  if (desks === undefined || desk === undefined || desk.seatId !== heldWith || desk.ownerId !== localId) {
    return undefined;
  }
  const open = desk.phase === DESK_TERMINAL_PHASE.open && desk.agentId !== "";
  return {
    seatId: desk.seatId,
    agentId: open ? desk.agentId : "",
    message: open ? "" : deskPhaseText(desk.phase, desk.note, desk.phase === DESK_TERMINAL_PHASE.waiting && othersOn(desks, localId, heldWith)),
    needsInput: open && desk.needsInput,
    activity: open ? desk.activity : "",
    promptsAfter,
  };
}

/**
 * The prompts the desk panel lists: those typed into its agent since the
 * computer was turned on. The same slot is lent again the next time, so its
 * agent id alone would carry the last session's prompts over.
 */
export function deskPrompts(entries: readonly AgentPromptEntry[], panel: DeskPanelView): readonly AgentPromptEntry[] {
  if (panel.agentId === "") {
    return [];
  }
  return entries.filter((entry) => entry.agentId === panel.agentId && entry.id > panel.promptsAfter);
}

/** Whether the local player has a session running at another desk than `seatId`, holding an agent this desk could have had. */
function othersOn(desks: DeskReadings, localId: string, seatId: string): boolean {
  for (const desk of desks.values()) {
    if (desk.ownerId === localId && desk.seatId !== seatId && (desk.phase === DESK_TERMINAL_PHASE.open || desk.phase === DESK_TERMINAL_PHASE.starting)) {
      return true;
    }
  }
  return false;
}

/**
 * Why the desk has no terminal to prompt yet, or any more.
 *
 * @param othersOn the player's other desks hold agents, so turning one off frees one here.
 */
export function deskPhaseText(phase: string, note: string, othersOn = false): string {
  switch (phase) {
    case DESK_TERMINAL_PHASE.waiting:
      return othersOn
        ? "Every coding agent is busy, your other desks' computers included. This desk gets one as soon as one is free; turn another desk's computer off to free one."
        : "Every coding agent is busy. This desk gets one as soon as one is free.";
    case DESK_TERMINAL_PHASE.noRunner:
      return "No agent runner is connected, so this desk's computer has no coding agent to run. Start a runner, or sit down again once one is up.";
    case DESK_TERMINAL_PHASE.ended:
      return `The session ended${note === "" ? "." : `: ${note.replace(/\.$/, "")}.`} Stand up and sit down again for a fresh one.`;
    default:
      return "Starting a coding agent at this desk…";
  }
}

/** What a player is told on sitting at a computer someone else has on. */
export function deskTakenText(ownerName: string | undefined): string {
  const who = ownerName === undefined ? "Someone else" : ownerName;
  return `${who} has this desk's computer on: only they can use it or turn it off.`;
}

/** Whether two panel views read the same, so an unchanged one is not published again. */
export function sameDeskPanel(a: DeskPanelView | undefined, b: DeskPanelView | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return a.seatId === b.seatId && a.agentId === b.agentId && a.message === b.message && a.needsInput === b.needsInput && a.activity === b.activity && a.promptsAfter === b.promptsAfter;
}

/** What the desk's monitor is keyed by while it shows a placeholder, before an agent's terminal is there to show. */
function deskPlaceholderKey(seatId: string): string {
  return `desk:${seatId}`;
}

/**
 * Whose terminal the desk's monitor shows, keyed for the desk's screen: the
 * lent agent's once the session is open, a placeholder while one is on its
 * way, and nothing while the desk has no agent coming.
 */
export function deskScreenKey(desk: DeskReading | undefined): string | undefined {
  if (desk === undefined || desk.seatId === "") {
    return undefined;
  }
  switch (desk.phase) {
    case DESK_TERMINAL_PHASE.open:
      return desk.agentId === "" ? deskPlaceholderKey(desk.seatId) : desk.agentId;
    case DESK_TERMINAL_PHASE.starting:
    case DESK_TERMINAL_PHASE.waiting:
      return deskPlaceholderKey(desk.seatId);
    default:
      return undefined;
  }
}
