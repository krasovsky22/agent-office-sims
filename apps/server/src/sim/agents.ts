/**
 * Putting the agent employees on the floor when a room opens.
 *
 * Who they are and where they stand is decided by `planAgentHires` in the
 * shared package; this only turns that plan into replicated state. It runs once,
 * from `onCreate`, before anyone can join, so the first client to arrive already
 * finds them at their desks.
 *
 * An agent has no session, so it has none of the server-side bookkeeping a
 * player does: no motion record for the tick to validate poses against, and no
 * expression budget. It moves only when `agentMotion.ts` has an intent for it,
 * so a standing agent costs nothing on the wire after the patch that
 * introduced it.
 */

import {
  AGENT_ACTIVITY,
  AGENT_STAT_MAX,
  ANIMATION_STATE,
  AgentEmployee,
  type Occupant,
  type OfficeLayout,
  normalizeYaw,
  planAgentHires,
} from "@sim/shared";

/**
 * Adds `count` agents to the occupants map, keyed by their stable ids.
 *
 * @returns the agents hired, in hiring order.
 */
export function hireAgentEmployees(
  occupants: { set(id: string, occupant: Occupant): unknown },
  layout: OfficeLayout,
  count: number,
): AgentEmployee[] {
  return planAgentHires(layout, count).map((hire) => {
    const agent = new AgentEmployee();
    agent.id = hire.id;
    agent.name = hire.name;
    agent.jobTitle = hire.jobTitle;
    agent.deskId = hire.deskId;
    agent.x = hire.stand.x;
    agent.z = hire.stand.z;
    agent.yaw = normalizeYaw(hire.stand.yaw);
    agent.animation = ANIMATION_STATE.idle;
    agent.activity = AGENT_ACTIVITY.idle;
    agent.currentTicketId = "";
    agent.morale = AGENT_STAT_MAX;
    agent.energy = AGENT_STAT_MAX;
    occupants.set(agent.id, agent);
    return agent;
  });
}
