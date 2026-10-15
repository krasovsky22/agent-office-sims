/**
 * Who the agent employees are, who the office could hire next, and where each
 * one works.
 *
 * Data, like the floor plan, and for the same reason: the people on the floor
 * should be the same people every time the room starts. The roster is written
 * down in order and a room with `n` agents hires the first `n` of it, onto the
 * first `n` of the layout's {@link OfficeLayout.agentDesks}. Nothing here is
 * random, so a tab that reconnects — or a server that restarts — finds Ada at
 * the same desk with the same title.
 *
 * Hiring after the room opens draws on the same tables: the CEO picks one of
 * {@link HIRING_CANDIDATES}, and {@link planHire} decides who that is and
 * which desk they get. The rules around it — who may hire, and when — are
 * `staffing.ts`'s.
 *
 * The server is the only caller of the planners; the client sees agents
 * through replicated state, and reads only the candidate list, to offer it.
 * The planners live in the shared package anyway because a plan is a pure
 * function of the layout, and the layout is shared.
 */

import { dailyPayroll } from "./company.js";
import {
  type DeskSpec,
  INTERACTION_KIND,
  type OfficeLayout,
  type SpawnSpec,
  type Vec2,
  interactables,
  workstations,
} from "./layout.js";
import {
  AGENT_ACTIVITY,
  AGENT_STAT_MAX,
  ANIMATION_STATE,
  AgentEmployee,
  type Occupant,
  isAgentEmployee,
  normalizeYaw,
} from "./state.js";

/**
 * A job the office can hire for: its title, and what it pays a day.
 *
 * The salaries are the one company tunable that lives outside `company.ts`,
 * because a salary means nothing apart from the job it pays for.
 */
export interface HiringCandidate {
  /** Stable key a hire command names; never shown. */
  readonly id: string;
  readonly jobTitle: string;
  /** Whole currency units drawn at every midnight while the agent is on staff. */
  readonly salary: number;
}

/**
 * Every job the CEO can hire for, in the order the HUD lists them.
 *
 * Also the starting staff's jobs, in hiring order: the roster pairs the first
 * names with these titles.
 */
export const HIRING_CANDIDATES: readonly HiringCandidate[] = [
  { id: "backend-engineer", jobTitle: "Backend Engineer", salary: 600 },
  { id: "frontend-engineer", jobTitle: "Frontend Engineer", salary: 550 },
  { id: "product-designer", jobTitle: "Product Designer", salary: 550 },
  { id: "qa-engineer", jobTitle: "QA Engineer", salary: 500 },
  { id: "data-analyst", jobTitle: "Data Analyst", salary: 500 },
  { id: "devops-engineer", jobTitle: "DevOps Engineer", salary: 650 },
  { id: "technical-writer", jobTitle: "Technical Writer", salary: 450 },
  { id: "security-engineer", jobTitle: "Security Engineer", salary: 700 },
];

/** The candidate with this id, or `undefined` for one the office does not offer. */
export function hiringCandidateById(id: string): HiringCandidate | undefined {
  return HIRING_CANDIDATES.find((candidate) => candidate.id === id);
}

/**
 * The names agents are given, in the order they are handed out.
 *
 * Twice as many as there are agent desks, so a hire always finds a name nobody
 * on the floor is using, and someone fired is not straight away replaced by a
 * namesake. Full names, so an agent is never confused with a player who joined
 * as `Employee 3`.
 */
export const AGENT_NAMES: readonly string[] = [
  "Ada Byrne",
  "Bo Mendes",
  "Cleo Hart",
  "Dax Okafor",
  "Esme Ruiz",
  "Finn Kato",
  "Gia Novak",
  "Hugo Lind",
  "Ivy Chen",
  "Jonah Reyes",
  "Kai Moreau",
  "Lena Ford",
  "Milo Varga",
  "Nia Adeyemi",
  "Omar Haddad",
  "Priya Nair",
];

/** One person the office can hire. */
export interface AgentProfile {
  readonly name: string;
  readonly jobTitle: string;
  readonly salary: number;
}

/**
 * Everyone the room hires when it opens, in hiring order: one of each
 * candidate job, under the first of {@link AGENT_NAMES}.
 *
 * Eight, which is more than a room should start with: the default is
 * {@link DEFAULT_AGENT_COUNT}, and the issue that set the count was clear that a
 * floor of twenty agents is a floor nobody can read. The board is what carries
 * the sense of scale.
 */
export const AGENT_ROSTER: readonly AgentProfile[] = HIRING_CANDIDATES.map((candidate, index) => ({
  name: AGENT_NAMES[index] ?? candidate.jobTitle,
  jobTitle: candidate.jobTitle,
  salary: candidate.salary,
}));

/** Most agents a room can hire: one per roster entry. */
export const MAX_AGENT_COUNT = AGENT_ROSTER.length;

/** Agents a room hires when the deployment does not say. */
export const DEFAULT_AGENT_COUNT = 4;

/** One agent the room is about to hire: who, which desk, and where to stand. */
export interface AgentHire extends AgentProfile {
  /**
   * Occupant id: `agent-` and the hire's number, so the opening staff's ids are
   * stable across restarts. It cannot collide with a player's: the opening
   * staff are hired before anyone can join, and a later hire skips any id
   * already in the occupants map.
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
    hires.push({
      ...profile,
      id: `agent-${hires.length + 1}`,
      deskId,
      stand: standAt(layout, deskId),
    });
  }
  return hires;
}

/** {@link deskStand} for a desk the layout must have. */
function standAt(layout: OfficeLayout, deskId: string): SpawnSpec {
  const stand = deskStand(layout, deskId);
  if (stand === undefined) {
    throw new Error(`agent desk ${deskId} is not a desk in the layout`);
  }
  return stand;
}

/**
 * The first agent desk a new hire could be put at, or why there is none.
 *
 * A desk is free when no agent has it and nobody is sitting at one of its
 * seats. The second matters because a hire stands where a player getting up
 * from that chair would be put down: giving the desk out from under a seated
 * player would stand two bodies in one place, which is exactly what bounding
 * hiring by the floor plan is for.
 */
export function freeAgentDesk(
  layout: OfficeLayout,
  occupants: Iterable<Occupant>,
): { readonly deskId: string } | { readonly deskId: undefined; readonly reason: "full" | "in-use" } {
  const taken = new Set<string>();
  const sitting = new Set<string>();
  for (const occupant of occupants) {
    if (isAgentEmployee(occupant)) {
      taken.add(occupant.deskId);
    } else if (occupant.interactableId !== "") {
      sitting.add(occupant.interactableId);
    }
  }

  let inUse = false;
  for (const deskId of layout.agentDesks) {
    if (taken.has(deskId)) {
      continue;
    }
    const seated = interactables(layout).some(
      (spec) => spec.deskId === deskId && sitting.has(spec.id),
    );
    if (!seated) {
      return { deskId };
    }
    inUse = true;
  }
  return { deskId: undefined, reason: inUse ? "in-use" : "full" };
}

/**
 * The agent a room hiring `candidate` now would put on the floor.
 *
 * `hireNumber` is how many agents the room has ever hired, this one included;
 * it is what makes the id and the name move on after a firing instead of
 * reusing the fired agent's. An id or a name already on the floor is skipped.
 * Whether the hire is allowed at all — the role, a free desk — is
 * the caller's to have checked; `deskId` is the desk {@link freeAgentDesk}
 * found.
 */
export function planHire(
  layout: OfficeLayout,
  occupants: Iterable<Occupant>,
  candidate: HiringCandidate,
  deskId: string,
  hireNumber: number,
): AgentHire {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const occupant of occupants) {
    ids.add(occupant.id);
    names.add(occupant.name);
  }

  let number = hireNumber;
  while (ids.has(`agent-${number}`)) {
    number += 1;
  }
  let name = candidate.jobTitle;
  for (let offset = 0; offset < AGENT_NAMES.length; offset += 1) {
    const option = AGENT_NAMES[(hireNumber - 1 + offset) % AGENT_NAMES.length];
    if (option !== undefined && !names.has(option)) {
      name = option;
      break;
    }
  }

  return {
    id: `agent-${number}`,
    name,
    jobTitle: candidate.jobTitle,
    salary: candidate.salary,
    deskId,
    stand: standAt(layout, deskId),
  };
}

/**
 * The replicated agent a hire plan describes, standing at its desk.
 *
 * The one place an {@link AgentEmployee} is built, so an agent the room opens
 * with and an agent the CEO hires later arrive in the same state.
 */
export function employAgent(hire: AgentHire): AgentEmployee {
  const agent = new AgentEmployee();
  agent.id = hire.id;
  agent.name = hire.name;
  agent.jobTitle = hire.jobTitle;
  agent.salary = hire.salary;
  agent.deskId = hire.deskId;
  agent.x = hire.stand.x;
  agent.z = hire.stand.z;
  agent.yaw = normalizeYaw(hire.stand.yaw);
  agent.animation = ANIMATION_STATE.idle;
  agent.activity = AGENT_ACTIVITY.idle;
  agent.currentTicketId = "";
  agent.morale = AGENT_STAT_MAX;
  agent.energy = AGENT_STAT_MAX;
  return agent;
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

/**
 * What the staff on the floor cost a day: the payroll the next midnight draws.
 *
 * Read by the server at midnight. The HUD's payroll line adds up the same
 * replicated salaries through the same `dailyPayroll`, so the figure on screen
 * is the one that is charged.
 */
export function payrollOf(occupants: Iterable<Occupant>): number {
  return dailyPayroll(salariesOf(occupants));
}

function* salariesOf(occupants: Iterable<Occupant>): Iterable<number> {
  for (const occupant of occupants) {
    if (isAgentEmployee(occupant)) {
      yield occupant.salary;
    }
  }
}
