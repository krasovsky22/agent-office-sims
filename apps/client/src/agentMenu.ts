/**
 * The menu a long press of `E` opens on the coding agent the player faces,
 * idle or at work: cancel its task, or fire it, in words the HUD can show.
 *
 * Which agent is faced is decided here, from where the bodies are drawn. The
 * decision whether an option may be taken is not: `agentActionRefusal` in
 * `@sim/shared` is the rule the server enforces, and this module only asks it,
 * so the menu offers a button exactly when the server would act on it, and
 * says why not otherwise.
 */

import {
  AGENT_ACTION,
  AGENT_ACTION_REJECTION,
  type AgentAction,
  type AgentActionRejection,
  type OfficeActor,
  type WorkData,
  agentActionRefusal,
  agentActionTarget,
} from "@sim/shared";

/** How long `E` is held for the menu; a shorter press is `E` as it always was. */
export const AGENT_MENU_HOLD_MS = 500;

/** How near an agent has to be to be faced, in metres: an arm's length past a desk chair. */
export const AGENT_MENU_RANGE = 2.2;

/** How far off straight ahead a faced agent may be, as the cosine of the angle: about 55°. */
const FACING_COSINE = Math.cos((55 * Math.PI) / 180);

/** Where an agent stands, by occupant id. */
export interface AgentSpot {
  readonly id: string;
  readonly x: number;
  readonly z: number;
}

/**
 * The agent the player faces, the nearest in front within reach, or
 * `undefined`. Facing is the body's yaw, forward being `-Z` turned by it, as
 * the server walks bodies.
 */
export function facedAgent(pose: { readonly x: number; readonly z: number; readonly yaw: number }, agents: Iterable<AgentSpot>): string | undefined {
  const forwardX = -Math.sin(pose.yaw);
  const forwardZ = -Math.cos(pose.yaw);
  let nearest: string | undefined;
  let nearestDistance = AGENT_MENU_RANGE;
  for (const agent of agents) {
    const dx = agent.x - pose.x;
    const dz = agent.z - pose.z;
    const distance = Math.hypot(dx, dz);
    if (distance > nearestDistance || distance === 0 || (dx * forwardX + dz * forwardZ) / distance < FACING_COSINE) {
      continue;
    }
    nearest = agent.id;
    nearestDistance = distance;
  }
  return nearest;
}

export interface AgentMenuOption {
  readonly action: AgentAction;
  readonly label: string;
  /** Why the server would refuse it, or `undefined` when it would act on it. */
  readonly refusal: string | undefined;
}

/** The menu open on one agent, as the HUD draws it. */
export interface AgentMenuView {
  readonly agentId: string;
  readonly agentName: string;
  /** What it has in hand, `#39`, or `""` for nothing. */
  readonly task: string;
  readonly options: readonly AgentMenuOption[];
}

/**
 * The menu on an agent for the local player.
 *
 * @param ceoName `undefined` while the roster has not shown who holds the role.
 */
export function agentMenuFor(
  actor: OfficeActor,
  agent: { readonly id: string; readonly name: string; readonly profileEditable: boolean; readonly fired: boolean },
  work: readonly WorkData[],
  ceoName: string | undefined,
): AgentMenuView {
  const target = agentActionTarget(agent, work);
  const option = (action: AgentAction, label: string): AgentMenuOption => {
    const rejection = agentActionRefusal(actor, action, target);
    return { action, label, refusal: rejection === undefined ? undefined : agentActionRejectionText(rejection, agent.name, ceoName) };
  };
  return {
    agentId: agent.id,
    agentName: agent.name,
    task: target.issueNumber === undefined ? "" : `#${target.issueNumber}`,
    options: [option(AGENT_ACTION.cancel, "Cancel task"), option(AGENT_ACTION.fire, "Fire agent")],
  };
}

/** Why a cancel or a firing will not be, or was not, carried out. */
export function agentActionRejectionText(rejection: AgentActionRejection, agentName: string, ceoName?: string): string {
  switch (rejection) {
    case AGENT_ACTION_REJECTION.forbidden:
      return `Only ${ceoName === undefined ? "the CEO" : `the CEO, ${ceoName},`} can cancel an agent's task or fire it.`;
    case AGENT_ACTION_REJECTION.noAgent:
      return `${agentName} is run by its orchestrator, out of the office's reach.`;
    case AGENT_ACTION_REJECTION.leaving:
      return `${agentName} is already on the way out.`;
    case AGENT_ACTION_REJECTION.noTask:
      return `${agentName} has no task to cancel.`;
    case AGENT_ACTION_REJECTION.offline:
      return `${agentName}'s runner could not be told; it may be offline. Try again shortly.`;
  }
}
