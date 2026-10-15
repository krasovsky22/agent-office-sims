/**
 * Who the agent employees are, and where each one works.
 *
 * Data, like the floor plan, and for the same reason: the people on the floor
 * should be the same people every time the room starts. The roster is written
 * down in order and a room with `n` agents hires the first `n` of it, onto the
 * first `n` of the layout's {@link OfficeLayout.agentDesks}. Nothing here is
 * random, so a tab that reconnects — or a server that restarts — finds Ada at
 * the same desk with the same title.
 *
 * The server is the only caller; the client sees agents through replicated
 * state. It lives in the shared package anyway because the plan is a pure
 * function of the layout, and the layout is shared.
 */

import { type DeskSpec, type OfficeLayout, type SpawnSpec, workstations } from "./layout.js";

/** One person the office can hire. */
export interface AgentProfile {
  readonly name: string;
  readonly jobTitle: string;
}

/**
 * Everyone the office can hire, in hiring order.
 *
 * Eight, which is more than a room should start with: the default is
 * {@link DEFAULT_AGENT_COUNT}, and the issue that set the count was clear that a
 * floor of twenty agents is a floor nobody can read. The board is what carries
 * the sense of scale. Full names, so an agent is never confused with a player
 * who joined as `Employee 3`.
 */
export const AGENT_ROSTER: readonly AgentProfile[] = [
  { name: "Ada Byrne", jobTitle: "Backend Engineer" },
  { name: "Bo Mendes", jobTitle: "Frontend Engineer" },
  { name: "Cleo Hart", jobTitle: "Product Designer" },
  { name: "Dax Okafor", jobTitle: "QA Engineer" },
  { name: "Esme Ruiz", jobTitle: "Data Analyst" },
  { name: "Finn Kato", jobTitle: "DevOps Engineer" },
  { name: "Gia Novak", jobTitle: "Technical Writer" },
  { name: "Hugo Lind", jobTitle: "Security Engineer" },
];

/** Most agents a room can hire: one per roster entry. */
export const MAX_AGENT_COUNT = AGENT_ROSTER.length;

/** Agents a room hires when the deployment does not say. */
export const DEFAULT_AGENT_COUNT = 4;

/** One agent the room is about to hire: who, which desk, and where to stand. */
export interface AgentHire extends AgentProfile {
  /**
   * Occupant id, stable across restarts. Cannot collide with a player's: a
   * Colyseus session id is nine characters long, and these are seven.
   */
  readonly id: string;
  readonly deskId: string;
  /** Behind the chair of the desk's first workstation, facing the desk. */
  readonly stand: SpawnSpec;
}

/**
 * The agents a room with `count` of them hires.
 *
 * Asking for more than the roster or the layout's agent desks can supply gets
 * as many as both allow, and a negative or fractional count is read as the
 * whole number below it; deciding whether such a count is a mistake is the
 * configuration's business, not this function's.
 *
 * Each agent stands where someone getting up from that desk's chair would be
 * put down — clear of the chair by construction, and checked clear of every
 * obstacle by the layout's own invariants — so the chair stays free and an
 * agent that later sits down only has to take the seat in front of it.
 */
export function planAgentHires(layout: OfficeLayout, count: number): AgentHire[] {
  const desksById = new Map<string, DeskSpec>(layout.desks.map((spec) => [spec.id, spec]));
  const wanted = Math.max(0, Math.floor(count));
  const hires: AgentHire[] = [];

  for (const deskId of layout.agentDesks) {
    const profile = AGENT_ROSTER[hires.length];
    if (hires.length >= wanted || profile === undefined) {
      break;
    }
    const desk = desksById.get(deskId);
    const workstation = desk === undefined ? undefined : workstations(desk)[0];
    if (desk === undefined || workstation === undefined) {
      // An unknown desk id is a layout problem `describeLayoutProblems`
      // reports; the room still starts, one agent short.
      continue;
    }
    hires.push({
      ...profile,
      id: `agent-${hires.length + 1}`,
      deskId,
      stand: { x: workstation.exit.x, z: workstation.exit.z, yaw: desk.yaw },
    });
  }
  return hires;
}
