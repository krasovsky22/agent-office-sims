/**
 * The desk terminal: the computer at an empty desk, which the CEO sitting
 * there uses as a coding agent's terminal of their own.
 *
 * Sitting at a desk with a monitor that no agent holds, the CEO is lent one of
 * the runners' idle coding agents: a fresh session of it, with no issue and no
 * first prompt, started in a scratch worktree of the default branch, shown on
 * that desk's monitor and in the terminal panel, and prompted from there as the
 * CEO prompts any coding agent. It keeps running when the CEO stands up, its
 * terminal still on the desk's monitor, and sitting there again is back at the
 * same session. Turning the computer off, leaving, or handing the role on ends
 * it, its agent stopped and its worktree discarded, and the slot goes back to
 * the floor for issue work; the next sitting starts a fresh one. What it does
 * runs real commands on the runner's host, so it is held to the rule that gates
 * prompting a coding agent, which is the CEO's alone; anyone else sitting at a
 * desk gets no terminal.
 *
 * What the session is doing is replicated state (`DeskTerminal` in
 * `./state.ts`), run by the server (`apps/server/src/agents/deskTerminal.ts`);
 * this module is what both sides need: the gate, which seats have a computer,
 * and the phases the client says something about.
 */

import { type AgentPromptRejection, agentPromptRefusal } from "./agentPrompt.js";
import { interactableById } from "./interaction.js";
import { INTERACTION_KIND, type InteractableSpec, MANAGER_DESK_ID, type OfficeLayout } from "./layout.js";
import { monitorOfSeat } from "./props.js";
import type { OfficeActor } from "./work.js";

/** Where the CEO's desk terminal stands. */
export const DESK_TERMINAL_PHASE = {
  /** The CEO's desk's computer is off. */
  off: "",
  /** Every runner's coding agent is busy; one is lent as soon as one is free. */
  waiting: "waiting",
  /** An agent is lent, and its runner is starting the session. */
  starting: "starting",
  /** The session is up, and its terminal is the desk's. */
  open: "open",
  /** No runner is connected, so there is no agent to lend. */
  noRunner: "no-runner",
  /** The runner ended the session, or would not start it; the note says why. Sitting down again tries afresh. */
  ended: "ended",
} as const;

export type DeskTerminalPhase = (typeof DESK_TERMINAL_PHASE)[keyof typeof DESK_TERMINAL_PHASE];

/**
 * Whether an actor may have a desk's terminal, and if not, why. The prompt
 * gate itself: a desk terminal is a coding agent the CEO prompts.
 */
export function deskTerminalRefusal(actor: OfficeActor): AgentPromptRejection | undefined {
  return agentPromptRefusal(actor);
}

/**
 * The seat whose desk has a computer to use, or `undefined` for anything
 * else: a seat with a monitor in front of it, other than the AI Manager's.
 */
export function deskTerminalSeat(layout: OfficeLayout, interactableId: string): InteractableSpec | undefined {
  if (interactableId === "") {
    return undefined;
  }
  const seat = interactableById(layout, interactableId);
  if (seat === undefined || seat.kind !== INTERACTION_KIND.seat || seat.deskId === MANAGER_DESK_ID) {
    return undefined;
  }
  return monitorOfSeat(layout, seat.id) === undefined ? undefined : seat;
}
