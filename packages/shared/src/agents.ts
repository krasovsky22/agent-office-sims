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

import {
  type DeskSpec,
  INTERACTION_KIND,
  type OfficeLayout,
  type SpawnSpec,
  type Vec2,
  workstations,
} from "./layout.js";
import { type Occupant, isAgentEmployee } from "./state.js";

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
 * as many as both allow. The count itself is the configuration's to validate,
 * and the desk ids the layout's.
 *
 * Each agent stands where someone getting up from that desk's chair would be
 * put down — clear of the chair by construction, and checked clear of every
 * obstacle by the layout's own invariants — so the chair stays free and an
 * agent that later sits down only has to take the seat in front of it.
 */
export function planAgentHires(layout: OfficeLayout, count: number): AgentHire[] {
  const hires: AgentHire[] = [];

  for (const deskId of layout.agentDesks) {
    const profile = AGENT_ROSTER[hires.length];
    if (hires.length >= count || profile === undefined) {
      break;
    }
    const stand = deskStand(layout, deskId);
    if (stand === undefined) {
      throw new Error(`agent desk ${deskId} is not a desk in the layout`);
    }
    hires.push({ ...profile, id: `agent-${hires.length + 1}`, deskId, stand });
  }
  return hires;
}

/**
 * Where an agent stands at its desk when it is not sitting at it: behind the
 * chair of the desk's first workstation, facing the desk.
 *
 * Where it is hired, and where it goes back to between tickets, so an agent
 * with nothing to do is always found at its own desk.
 */
export function deskStand(layout: OfficeLayout, deskId: string): SpawnSpec | undefined {
  const desk: DeskSpec | undefined = layout.desks.find((spec) => spec.id === deskId);
  const workstation = desk === undefined ? undefined : workstations(desk)[0];
  if (desk === undefined || workstation === undefined) {
    return undefined;
  }
  return { x: workstation.exit.x, z: workstation.exit.z, yaw: desk.yaw };
}

/**
 * Where an agent carries a deliverable: the reader's spot at the layout's
 * whiteboard, facing it, which is where the ticket board is read and worked.
 *
 * Read from the layout rather than written down here, so moving the board
 * moves where the agents walk to.
 */
export function ticketBoardStand(layout: OfficeLayout): SpawnSpec | undefined {
  const board = layout.fixtures.find((spec) => spec.kind === INTERACTION_KIND.whiteboard);
  return board === undefined ? undefined : { ...board.anchor };
}

/**
 * A point `distance` metres ahead of a pose, along its yaw.
 *
 * A body is turned by facing a point, so this is how a pose's yaw becomes
 * something to face. Yaw 0 faces -Z, as it does everywhere in the layout.
 */
export function pointAhead(pose: SpawnSpec, distance = 1): Vec2 {
  return { x: pose.x - Math.sin(pose.yaw) * distance, z: pose.z - Math.cos(pose.yaw) * distance };
}

/**
 * The agent employee given a desk, or `undefined` if no agent has it.
 *
 * Read from the occupants map on both sides, so the client's prompt and the
 * server's refusal agree on whose desk it is.
 */
export function agentAtDesk(occupants: Iterable<Occupant>, deskId: string): string | undefined {
  for (const occupant of occupants) {
    if (isAgentEmployee(occupant) && occupant.deskId === deskId) {
      return occupant.id;
    }
  }
  return undefined;
}
