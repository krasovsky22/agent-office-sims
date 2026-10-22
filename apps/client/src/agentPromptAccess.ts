/**
 * What the local player may type to a coding agent from its terminal panel,
 * in words the HUD can show.
 *
 * The decision is not made here: `agentPromptRefusal` in `@sim/shared` is the
 * rule the server enforces, and this module only asks it about the local
 * player, so the panel's composer is enabled exactly when the server would
 * take the prompt, and everyone else is told why. Like `managerAccess.ts` for
 * the manager's composer. The keys the CEO presses on an agent's choice
 * screen are held to the same rule, and have words of their own here. At a
 * desk's computer the panel is its player's own, which the gate lets them
 * alone prompt, so it uses {@link DESK_PROMPT_ACCESS} instead.
 */

import {
  AGENT_KEY_LABEL,
  AGENT_PROMPT_REJECTION,
  type AgentKey,
  type AgentPromptRejection,
  type OfficeActor,
  agentPromptRefusal,
  isAgentKey,
} from "@sim/shared";

/** The local player's standing with the coding agents' terminals. */
export interface AgentPromptAccess {
  /** Whether the panel offers a composer the server will take prompts from. */
  readonly mayPrompt: boolean;
  /** One sentence on what this player may do, and why, for the panel. */
  readonly summary: string;
}

/** The local player's access at their own desk's computer, which only they may prompt. */
export const DESK_PROMPT_ACCESS: AgentPromptAccess = {
  mayPrompt: true,
  summary: "This desk's computer is a coding agent of your own. What you send is typed into it once it waits at its prompt; it runs on the runner's machine, and keeps running when you stand up, until you turn it off.",
};

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
      return "Only the CEO can prompt a coding agent, and only the player at its desk one lent to a desk's computer.";
    case AGENT_PROMPT_REJECTION.noAgent:
      return `${agentName} does not take prompts from the office.`;
    case AGENT_PROMPT_REJECTION.offline:
      return `${agentName}'s runner could not take the prompt; it may be offline. Try again shortly.`;
    case AGENT_PROMPT_REJECTION.busy:
      return `${agentName} is busy, so the prompt was not typed. Send it again once its turn is done.`;
    case AGENT_PROMPT_REJECTION.needsInput:
      return `${agentName} is waiting on a choice on its screen, so the prompt was not typed. Answer it with the keys.`;
    case AGENT_PROMPT_REJECTION.unavailable:
      return `${agentName} is not at its prompt: it has no task, or takes no prompts.`;
    case AGENT_PROMPT_REJECTION.unanswered:
      return `${agentName}'s runner never said whether it took the prompt; check its terminal before sending it again.`;
    case AGENT_PROMPT_REJECTION.notWaiting:
      return `${agentName} is not waiting on a choice, so the prompt was not typed.`;
  }
}

/** What to tell the player when a key they pressed was not pressed on the agent's screen. */
export function agentKeyRejectionText(rejection: AgentPromptRejection, agentName: string, key: AgentKey): string {
  const label = AGENT_KEY_LABEL[key];
  switch (rejection) {
    case AGENT_PROMPT_REJECTION.forbidden:
      return "Only the CEO can answer a coding agent's screen, and only the player at its desk one lent to a desk's computer.";
    case AGENT_PROMPT_REJECTION.noAgent:
      return `${agentName} does not take keys from the office.`;
    case AGENT_PROMPT_REJECTION.offline:
      return `${agentName}'s runner could not take ${label}; it may be offline. Try again shortly.`;
    case AGENT_PROMPT_REJECTION.busy:
    case AGENT_PROMPT_REJECTION.needsInput:
    case AGENT_PROMPT_REJECTION.notWaiting:
      return `${agentName} is not waiting on a choice, so ${label} was not pressed. Send it a prompt instead.`;
    case AGENT_PROMPT_REJECTION.unavailable:
      return `${agentName} has no screen to answer: it has no task, or takes no keys.`;
    case AGENT_PROMPT_REJECTION.unanswered:
      return `${agentName}'s runner never said whether it pressed ${label}; check its terminal before pressing anything else.`;
  }
}

/**
 * The agent key a key on the player's keyboard stands for, in the terminal
 * panel's key pad: the arrows, Enter and the digits. Esc is not one, since it
 * gives the keyboard back to the office there; the pad's Esc button presses it.
 */
export function agentKeyOfKeyboard(key: string): AgentKey | undefined {
  switch (key) {
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    case "Enter":
      return "enter";
    default:
      return /^[1-9]$/.test(key) && isAgentKey(key) ? key : undefined;
  }
}
