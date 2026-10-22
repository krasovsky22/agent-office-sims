/**
 * The desk terminal: the computer at an empty desk, which any player sitting
 * there uses as a coding agent's terminal of their own.
 *
 * Sitting at a desk with a monitor that no agent holds, a player is lent one of
 * the runners' idle coding agents: a fresh session of it, with no issue and no
 * first prompt, started in a scratch worktree of the default branch, shown on
 * that desk's monitor and in the terminal panel, and prompted from there as the
 * CEO prompts any coding agent. The session is that player's: only they prompt
 * it, press its keys or turn it off. It keeps running when they stand up, its
 * terminal still on the desk's monitor, and sitting there again is back at the
 * same session. Each desk is its own session, so a player may have several on
 * at once, as many as there are free agents. Turning a desk's computer off, or
 * leaving, ends it, its agent stopped and its worktree discarded, and the slot goes back to
 * the floor for issue work; the next sitting starts a fresh one. What it does
 * runs real commands on the runner's host, for whoever sits there, so the
 * office's link is for people trusted with that machine.
 *
 * What each session is doing is replicated state (`desks` in
 * `./state.ts`), run by the server (`apps/server/src/agents/deskTerminal.ts`);
 * this module is what both sides need: the gate, which seats have a computer,
 * and the phases the client says something about.
 */

import { AGENT_PROMPT_REJECTION, type AgentPromptRejection } from "./agentPrompt.js";
import { interactableById } from "./interaction.js";
import { INTERACTION_KIND, type InteractableSpec, MANAGER_DESK_ID, type OfficeLayout } from "./layout.js";
import { monitorOfSeat } from "./props.js";
import { OCCUPANT_KIND } from "./state.js";
import type { OfficeActor } from "./work.js";

/** Where a desk terminal stands. */
export const DESK_TERMINAL_PHASE = {
  /** The desk's computer is off; what a desk with no record in `desks` reads as. */
  off: "",
  /** Every runner's coding agent is busy, or lent to other desks; one is lent as soon as one is free. */
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

/** Whether an actor may have a desk's terminal, and if not, why: every player may, and nothing else. */
export function deskTerminalRefusal(actor: OfficeActor): AgentPromptRejection | undefined {
  return actor.kind === OCCUPANT_KIND.human ? undefined : AGENT_PROMPT_REJECTION.forbidden;
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
