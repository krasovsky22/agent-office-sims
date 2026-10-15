import { describe, expect, it } from "vitest";

import {
  AGENT_ROSTER,
  DEFAULT_AGENT_COUNT,
  MAX_AGENT_COUNT,
  planAgentHires,
} from "./agents.js";
import { isBlocked } from "./collision.js";
import { OCCUPANT_RADIUS } from "./constants.js";
import { OFFICE_LAYOUT, describeLayoutProblems, workstations } from "./layout.js";
import {
  AGENT_ACTIVITY,
  AgentEmployee,
  HumanPlayer,
  OCCUPANT_KIND,
  isAgentEmployee,
  isHumanPlayer,
} from "./state.js";

describe("planAgentHires", () => {
  it("hires the first n of the roster, onto the first n agent desks", () => {
    const hires = planAgentHires(OFFICE_LAYOUT, 3);
    expect(hires.map((hire) => hire.name)).toEqual(AGENT_ROSTER.slice(0, 3).map((p) => p.name));
    expect(hires.map((hire) => hire.deskId)).toEqual(OFFICE_LAYOUT.agentDesks.slice(0, 3));
    expect(hires.map((hire) => hire.id)).toEqual(["agent-1", "agent-2", "agent-3"]);
  });

  it("is the same plan every time, so names and desks survive a restart", () => {
    expect(planAgentHires(OFFICE_LAYOUT, MAX_AGENT_COUNT)).toEqual(
      planAgentHires(OFFICE_LAYOUT, MAX_AGENT_COUNT),
    );
  });

  it("starts a default room with between three and five agents", () => {
    const hires = planAgentHires(OFFICE_LAYOUT, DEFAULT_AGENT_COUNT);
    expect(hires.length).toBeGreaterThanOrEqual(3);
    expect(hires.length).toBeLessThanOrEqual(5);
  });

  it("has a desk in the layout for everyone on the roster", () => {
    expect(planAgentHires(OFFICE_LAYOUT, MAX_AGENT_COUNT)).toHaveLength(AGENT_ROSTER.length);
  });

  it("caps an oversized count at what the roster can supply", () => {
    expect(planAgentHires(OFFICE_LAYOUT, MAX_AGENT_COUNT + 10)).toHaveLength(MAX_AGENT_COUNT);
    expect(planAgentHires(OFFICE_LAYOUT, 0)).toEqual([]);
  });

  it("gives every agent a distinct name, title and desk", () => {
    const hires = planAgentHires(OFFICE_LAYOUT, MAX_AGENT_COUNT);
    expect(new Set(hires.map((hire) => hire.name)).size).toBe(hires.length);
    expect(new Set(hires.map((hire) => hire.jobTitle)).size).toBe(hires.length);
    expect(new Set(hires.map((hire) => hire.deskId)).size).toBe(hires.length);
  });

  it("stands each agent clear of every obstacle, behind its own chair and facing the desk", () => {
    for (const hire of planAgentHires(OFFICE_LAYOUT, MAX_AGENT_COUNT)) {
      const desk = OFFICE_LAYOUT.desks.find((spec) => spec.id === hire.deskId);
      const workstation = desk === undefined ? undefined : workstations(desk)[0];
      expect(workstation, hire.deskId).toBeDefined();
      expect(isBlocked(hire.stand, OCCUPANT_RADIUS, OFFICE_LAYOUT), hire.name).toBe(false);
      expect(hire.stand.x).toBeCloseTo(workstation?.exit.x ?? Number.NaN);
      expect(hire.stand.z).toBeCloseTo(workstation?.exit.z ?? Number.NaN);
      expect(hire.stand.yaw).toBe(desk?.yaw);
    }
  });
});

describe("agent desks in the layout", () => {
  it("reports an unknown desk and a desk given out twice", () => {
    const layout = {
      ...OFFICE_LAYOUT,
      agentDesks: ["desk-north-1", "desk-nowhere", "desk-north-1"],
    };
    expect(describeLayoutProblems(layout)).toEqual([
      "agent desk desk-nowhere is not a desk in the layout",
      "agent desk desk-north-1 is given out twice",
    ]);
  });
});

describe("AgentEmployee", () => {
  it("is an agent from construction, idle, with full morale and energy", () => {
    const agent = new AgentEmployee();
    expect(agent.kind).toBe(OCCUPANT_KIND.agent);
    expect(agent.activity).toBe(AGENT_ACTIVITY.idle);
    expect(agent.currentTicketId).toBe("");
    expect(agent.morale).toBe(100);
    expect(agent.energy).toBe(100);
  });

  it("is told apart from a player by kind alone", () => {
    const agent = new AgentEmployee();
    const player = new HumanPlayer();
    expect(isAgentEmployee(agent)).toBe(true);
    expect(isHumanPlayer(agent)).toBe(false);
    expect(isAgentEmployee(player)).toBe(false);
    // A client's reflected state is not an instance of either class.
    expect(isAgentEmployee({ ...player, kind: OCCUPANT_KIND.agent } as HumanPlayer)).toBe(true);
  });
});
