/**
 * The CEO prompting a coding agent from its terminal panel: who may, and why
 * a prompt was turned down.
 *
 * A prompt is code-steering input to a process that runs commands on the
 * runner's host, so it is held to the same rule as handing that agent work:
 * the CEO, and, where the server has an operator passphrase, only once they
 * have proved it ({@link mayCommandRealAgents}). The server asks
 * {@link agentPromptRefusal} on every prompt before anything is queued; the
 * client asks it only to disable the panel's composer and say why.
 *
 * Delivery is the runner's call, since only it knows whether its agent is
 * waiting at its prompt: a prompt is typed only then, and refused otherwise,
 * never queued behind the agent's turn.
 */

import { type OfficeActor, mayCommandRealAgents } from "./work.js";

/** Why a prompt for a coding agent was not typed into its terminal. Refusal changes nothing. */
export const AGENT_PROMPT_REJECTION = {
  /** Only the CEO prompts the coding agents. */
  forbidden: "forbidden",
  /** The CEO has not proved the operator passphrase on a server that asks for it. */
  notOperator: "not-operator",
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
} as const;

export type AgentPromptRejection = (typeof AGENT_PROMPT_REJECTION)[keyof typeof AGENT_PROMPT_REJECTION];

/**
 * Whether an actor may prompt a coding agent, and if not, why. **The one gate.**
 *
 * @param operatorRequired the replicated `operatorRequired`: whether this
 * server has an operator passphrase. Without one an office trusts its CEO, as
 * it does for handing out work.
 * @returns `undefined` when they may, else the rejection to send them.
 */
export function agentPromptRefusal(actor: OfficeActor, operatorRequired: boolean): AgentPromptRejection | undefined {
  if (!actor.isCeo) {
    return AGENT_PROMPT_REJECTION.forbidden;
  }
  if (operatorRequired && !mayCommandRealAgents(actor)) {
    return AGENT_PROMPT_REJECTION.notOperator;
  }
  return undefined;
}
