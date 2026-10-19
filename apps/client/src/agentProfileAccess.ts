/**
 * What the local player may do about a coding agent's profile, its name,
 * title and description, in words the HUD can show.
 *
 * The decision is not made here: `agentProfileRefusal` in `@sim/shared` is
 * the rule the server enforces, and this module only asks it about the local
 * player, so the roster offers the profile form exactly when the server would
 * take an edit, and everyone else reads the profile and is told why. Like
 * `agentPromptAccess.ts` for the terminal's composer.
 */

import {
  AGENT_PROFILE_REJECTION,
  type AgentProfile,
  type AgentProfileRejection,
  type OfficeActor,
  agentProfileRefusal,
  parseAgentProfile,
} from "@sim/shared";

/** The local player's standing with the agents' profiles. */
export interface AgentProfileAccess {
  /** Whether the roster offers a form the server will take edits from. */
  readonly mayEdit: boolean;
  /** One sentence on what this player may do, and why, for the profile card. */
  readonly summary: string;
}

/**
 * When an edit takes effect, said wherever a profile can be edited: a session
 * an agent is already in keeps the system prompt it started with.
 */
export const PROFILE_TAKES_EFFECT =
  "The title and description are the agent's system prompt: an edit applies from its next session or job, not the one it is in.";

/**
 * The local player's access.
 *
 * @param ceoName `undefined` while the roster has not shown who holds the role.
 */
export function agentProfileAccessFor(actor: OfficeActor, ceoName: string | undefined): AgentProfileAccess {
  if (agentProfileRefusal(actor) === undefined) {
    return { mayEdit: true, summary: "You are the CEO: you can rename this agent and change its title and description." };
  }
  const who = ceoName === undefined ? "the CEO" : `the CEO, ${ceoName},`;
  return { mayEdit: false, summary: `Only ${who} can edit an agent's profile.` };
}

/** What to tell the player when their edit was not passed on to the agent's runner. */
export function agentProfileRejectionText(rejection: AgentProfileRejection, agentName: string): string {
  switch (rejection) {
    case AGENT_PROFILE_REJECTION.forbidden:
      return "Only the CEO can edit a coding agent's profile.";
    case AGENT_PROFILE_REJECTION.noAgent:
      return `${agentName}'s profile is not kept by a runner, so it cannot be edited from the office.`;
    case AGENT_PROFILE_REJECTION.offline:
      return `${agentName}'s runner could not take the edit; it may be offline. Try again shortly.`;
  }
}

/**
 * The profile a form's fields make, as the server will keep it, or why it
 * cannot be sent: a name and a title are needed, a description is not.
 */
export function profileDraft(fields: { readonly name: string; readonly title: string; readonly description: string }):
  | { readonly ok: true; readonly profile: AgentProfile }
  | { readonly ok: false; readonly reason: string } {
  const profile = parseAgentProfile(fields);
  if (profile !== undefined) {
    return { ok: true, profile };
  }
  return { ok: false, reason: parseAgentProfile({ ...fields, name: "x" }) === undefined ? "Give it a title." : "Give it a name." };
}
