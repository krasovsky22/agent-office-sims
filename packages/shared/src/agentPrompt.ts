/**
 * The CEO prompting a coding agent from its terminal panel: who may, and why
 * a prompt was turned down.
 *
 * A prompt is code-steering input to a process that runs commands on the
 * runner's host, so it is held to the same rule as handing that agent work:
 * only the CEO. An agent lent to a desk's computer is the exception: it takes
 * prompts from the player who turned that desk on, and from nobody else, the
 * CEO included (`./deskTerminal.ts`). The server asks
 * {@link agentPromptRefusal} on every prompt before anything is queued; the
 * client asks it only to disable the panel's composer and say why.
 *
 * Delivery is the runner's call, since only it knows whether its agent is
 * waiting at its prompt: a prompt is typed only then, and refused otherwise,
 * never queued behind the agent's turn.
 *
 * A choice screen the agent stops on (a permission, a setup or trust screen)
 * takes a keypress, not a prompt: the Enter after pasted text would choose
 * whatever the screen has selected, whatever the text said. So the CEO answers
 * one with {@link AGENT_KEYS}, one key at a time, each under the same gate as
 * a prompt, and the runner presses it only while its agent waits on a person.
 */

import type { OfficeActor } from "./work.js";

/** Why a prompt for a coding agent was not typed into its terminal. Refusal changes nothing. */
export const AGENT_PROMPT_REJECTION = {
  /** Only the CEO prompts the coding agents, and only a desk's player the agent lent to it. */
  forbidden: "forbidden",
  /** Not a runner's coding agent in the office, or no longer here. */
  noAgent: "no-agent",
  /** Its runner could not be given the prompt: gone silent, or too much waiting for it. */
  offline: "offline",
  /** The agent is in the middle of a turn, or still starting. */
  busy: "busy",
  /** The agent waits on a permission, a question or a sign-in on its screen. */
  needsInput: "needs-input",
  /** The agent holds no task, or takes no prompts. */
  unavailable: "unavailable",
  /** Its runner never said whether it typed the prompt. */
  unanswered: "unanswered",
  /** A key for an agent that waits on no choice screen: it is working, or at its prompt. */
  notWaiting: "not-waiting",
} as const;

export type AgentPromptRejection = (typeof AGENT_PROMPT_REJECTION)[keyof typeof AGENT_PROMPT_REJECTION];

/**
 * Whether an actor may prompt a coding agent, and if not, why. **The one gate.**
 *
 * @param deskOwnerId the player whose desk the agent is lent to, `undefined` when it is lent to none.
 * @returns `undefined` when they may, else the rejection to send them.
 */
export function agentPromptRefusal(actor: OfficeActor, deskOwnerId?: string): AgentPromptRejection | undefined {
  if (deskOwnerId !== undefined) {
    return actor.id === deskOwnerId ? undefined : AGENT_PROMPT_REJECTION.forbidden;
  }
  return actor.isCeo ? undefined : AGENT_PROMPT_REJECTION.forbidden;
}

/**
 * The keys the CEO may press on a coding agent's choice screen: move between
 * its options, pick one by number, confirm, or cancel. Nothing that types
 * text, so a key can only answer the screen.
 */
export const AGENT_KEYS = ["up", "down", "enter", "escape", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

export type AgentKey = (typeof AGENT_KEYS)[number];

const AGENT_KEY_SET: ReadonlySet<string> = new Set(AGENT_KEYS);

export function isAgentKey(value: unknown): value is AgentKey {
  return typeof value === "string" && AGENT_KEY_SET.has(value);
}

/** How a key is named to a person: on its button, in the runner's log, in a refusal. */
export const AGENT_KEY_LABEL: Readonly<Record<AgentKey, string>> = {
  up: "Up",
  down: "Down",
  enter: "Enter",
  escape: "Esc",
  "1": "1",
  "2": "2",
  "3": "3",
  "4": "4",
  "5": "5",
  "6": "6",
  "7": "7",
  "8": "8",
  "9": "9",
};
