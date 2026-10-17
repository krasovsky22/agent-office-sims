/**
 * What the local player may type to a coding agent from its terminal panel,
 * in words the HUD can show.
 *
 * The decision is not made here: `agentPromptRefusal` in `@sim/shared` is the
 * rule the server enforces, and this module only asks it about the local
 * player, so the panel's composer is enabled exactly when the server would
 * take the prompt, and everyone else is told why. Like `managerAccess.ts` for
 * the manager's composer.
 */

import { AGENT_PROMPT_REJECTION, type AgentPromptRejection, type OfficeActor, agentPromptRefusal } from "@sim/shared";

/** The local player's standing with the coding agents' terminals. */
export interface AgentPromptAccess {
  /** Whether the panel offers a composer the server will take prompts from. */
  readonly mayPrompt: boolean;
  /** One sentence on what this player may do, and why, for the panel. */
  readonly summary: string;
}

/**
 * The local player's access.
 *
 * @param ceoName `undefined` while the roster has not shown who holds the role.
 */
export function agentPromptAccessFor(actor: OfficeActor, ceoName: string | undefined): AgentPromptAccess {
  if (agentPromptRefusal(actor) === undefined) {
    return {
      mayPrompt: true,
      summary: "You are the CEO: what you send is typed into this agent's terminal once it waits at its prompt.",
    };
  }
  const who = ceoName === undefined ? "the CEO" : `the CEO, ${ceoName},`;
  return {
    mayPrompt: false,
    summary: `Only ${who} can prompt this agent. You can watch its terminal.`,
  };
}

/** What to tell the player when their prompt was not typed into the agent's terminal. */
export function agentPromptRejectionText(rejection: AgentPromptRejection, agentName: string): string {
  switch (rejection) {
    case AGENT_PROMPT_REJECTION.forbidden:
      return "Only the CEO can prompt a coding agent.";
    case AGENT_PROMPT_REJECTION.noAgent:
      return `${agentName} does not take prompts from the office.`;
    case AGENT_PROMPT_REJECTION.offline:
      return `${agentName}'s runner could not take the prompt; it may be offline. Try again shortly.`;
    case AGENT_PROMPT_REJECTION.busy:
      return `${agentName} is busy, so the prompt was not typed. Send it again once its turn is done.`;
    case AGENT_PROMPT_REJECTION.needsInput:
      return `${agentName} is waiting on a permission, so the prompt was not typed.`;
    case AGENT_PROMPT_REJECTION.unavailable:
      return `${agentName} is not at its prompt: it has no task, or takes no prompts.`;
    case AGENT_PROMPT_REJECTION.unanswered:
      return `${agentName}'s runner never said whether it took the prompt; check its terminal before sending it again.`;
  }
}
