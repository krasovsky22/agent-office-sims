/**
 * Putting the agent employees on the floor when a room opens.
 *
 * Who they are and where they stand is decided by `planAgentHires` in the
 * shared package; this only turns that plan into replicated state. It runs once,
 * from `onCreate`, before anyone can join, so the first client to arrive already
 * finds them at their desks. Agents the CEO hires later arrive through
 * `staffHandlers.ts` instead, built by the same `employAgent`.
 *
 * An agent has no session, so it has none of the server-side bookkeeping a
 * player does: no motion record for the tick to validate poses against, and no
 * expression budget. It moves only when `agentMotion.ts` has an intent for it,
 * so a standing agent costs nothing on the wire after the patch that
 * introduced it.
 */

import {
  type AgentEmployee,
  type Occupant,
  type OfficeLayout,
  employAgent,
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
    const agent = employAgent(hire);
    occupants.set(agent.id, agent);
    return agent;
  });
}
