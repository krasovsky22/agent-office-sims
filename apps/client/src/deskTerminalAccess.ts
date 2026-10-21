/**
 * What the local player's desk shows them while they sit at a computer, in
 * words the HUD can show.
 *
 * Nothing is decided here. The server lends the CEO's desk a coding agent
 * (`DeskTerminal` in the replicated state) and this module only reads that
 * record for the local player: the CEO's own desk opens the terminal panel on
 * the lent agent's terminal, with a line saying why there is no terminal yet
 * when there is none, and again on the same session each time the CEO sits
 * back down, since it keeps running until they turn it off; anyone else sitting at a computer is told why it stays
 * off for them, since `deskTerminalRefusal` in `@sim/shared` holds it to the
 * rule for prompting a coding agent. Like `agentPromptAccess.ts` for the
 * panel's composer.
 */

import { type AgentPromptEntry, DESK_TERMINAL_PHASE, type DeskTerminal } from "@sim/shared";

/** The replicated desk terminal, as this module reads it. */
export type DeskReading = Pick<DeskTerminal, "seatId" | "ownerId" | "agentId" | "phase" | "needsInput" | "activity" | "note">;

/** What the CEO's desk panel shows. */
export interface DeskPanelView {
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
 * @param promptsAfter the last prompt entry id from before the computer was turned on.
 */
export function deskPanelFor(
  desk: DeskReading | undefined,
  localId: string,
  heldWith: string,
  promptsAfter: number,
): DeskPanelView | undefined {
  if (desk === undefined || heldWith === "" || desk.seatId !== heldWith || desk.ownerId !== localId) {
    return undefined;
  }
  const open = desk.phase === DESK_TERMINAL_PHASE.open && desk.agentId !== "";
  return {
    agentId: open ? desk.agentId : "",
    message: open ? "" : deskPhaseText(desk.phase, desk.note),
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

/** Why the desk has no terminal to prompt yet, or any more. */
export function deskPhaseText(phase: string, note: string): string {
  switch (phase) {
    case DESK_TERMINAL_PHASE.waiting:
      return "Every coding agent is busy. This desk gets one as soon as one is free.";
    case DESK_TERMINAL_PHASE.noRunner:
      return "No agent runner is connected, so this desk's computer has no coding agent to run. Start a runner, or sit down again once one is up.";
    case DESK_TERMINAL_PHASE.ended:
      return `The session ended${note === "" ? "." : `: ${note.replace(/\.$/, "")}.`} Stand up and sit down again for a fresh one.`;
    default:
      return "Starting a coding agent at this desk…";
  }
}

/** What the CEO is told on sitting at another computer while theirs is on. */
export const DESK_ON_ELSEWHERE_TEXT = "Your desk's computer is still on at another desk. Sit there to use it, or turn it off there first.";

/**
 * Whether the local player's own desk's computer has a session running at
 * another desk than `seatId`. Only once an agent is lent: one still waiting
 * for an agent is given up the moment its CEO stands up.
 */
export function deskOnElsewhere(desk: DeskReading | undefined, localId: string, seatId: string): boolean {
  return (
    desk !== undefined &&
    desk.ownerId === localId &&
    desk.seatId !== "" &&
    desk.seatId !== seatId &&
    (desk.phase === DESK_TERMINAL_PHASE.open || desk.phase === DESK_TERMINAL_PHASE.starting)
  );
}

/** What anyone but the CEO is told on sitting at a computer. */
export function deskForbiddenText(ceoName: string | undefined): string {
  const who = ceoName === undefined ? "the CEO" : `the CEO, ${ceoName},`;
  return `Only ${who} can use a desk's computer: what its coding agent runs, it runs on the runner's machine.`;
}

/** Whether two panel views read the same, so an unchanged one is not published again. */
export function sameDeskPanel(a: DeskPanelView | undefined, b: DeskPanelView | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return a.agentId === b.agentId && a.message === b.message && a.needsInput === b.needsInput && a.activity === b.activity && a.promptsAfter === b.promptsAfter;
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
