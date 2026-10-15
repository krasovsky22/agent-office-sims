/**
 * Agents are server-written state, so what has to hold is that they are in the
 * map the room replicates, that they reach a client the way a browser actually
 * receives them — through the reflected schema, not these classes — and that a
 * floor of standing agents costs nothing per patch.
 */

import { Encoder, Reflection } from "@colyseus/schema";
import {
  AGENT_ACTIVITY,
  AGENT_ROSTER,
  MAX_AGENT_COUNT,
  OCCUPANT_KIND,
  OFFICE_LAYOUT,
  OfficeState,
  isAgentEmployee,
  planAgentHires,
} from "@sim/shared";
import { describe, expect, it } from "vitest";

import { hireAgentEmployees } from "./agents.js";

describe("hireAgentEmployees", () => {
  it("puts the planned agents in the occupants map, at their desks", () => {
    const state = new OfficeState();
    const hired = hireAgentEmployees(state.occupants, OFFICE_LAYOUT, 4);

    const plan = planAgentHires(OFFICE_LAYOUT, 4);
    expect(hired.map((agent) => agent.id)).toEqual(plan.map((hire) => hire.id));
    expect(state.occupants.size).toBe(4);
    plan.forEach((hire) => {
      const agent = state.occupants.get(hire.id);
      expect(agent !== undefined && isAgentEmployee(agent)).toBe(true);
      if (agent === undefined || !isAgentEmployee(agent)) {
        return;
      }
      expect(agent.name).toBe(hire.name);
      expect(agent.jobTitle).toBe(hire.jobTitle);
      expect(agent.deskId).toBe(hire.deskId);
      expect(agent.x).toBeCloseTo(hire.stand.x);
      expect(agent.z).toBeCloseTo(hire.stand.z);
      expect(agent.activity).toBe(AGENT_ACTIVITY.idle);
      expect(agent.interactableId).toBe("");
    });
  });

  it("hires nobody when the count is zero", () => {
    const state = new OfficeState();
    expect(hireAgentEmployees(state.occupants, OFFICE_LAYOUT, 0)).toEqual([]);
    expect(state.occupants.size).toBe(0);
  });

  it("reaches a client with every agent field, through the reflected schema", () => {
    const state = new OfficeState();
    hireAgentEmployees(state.occupants, OFFICE_LAYOUT, 3);
    const encoder = new Encoder(state);

    // What a browser does on join: rebuild the types from the handshake, then
    // decode the full state into them.
    const decoder = Reflection.decode<OfficeState>(Reflection.encode(encoder));
    decoder.decode(encoder.encodeAll());

    const seen = [...decoder.state.occupants.values()];
    expect(seen.map((occupant) => occupant.name)).toEqual(
      AGENT_ROSTER.slice(0, 3).map((profile) => profile.name),
    );
    for (const occupant of seen) {
      expect(occupant.kind).toBe(OCCUPANT_KIND.agent);
      expect(isAgentEmployee(occupant)).toBe(true);
      if (isAgentEmployee(occupant)) {
        expect(occupant.jobTitle).not.toBe("");
        expect(occupant.deskId).not.toBe("");
        expect(occupant.activity).toBe(AGENT_ACTIVITY.idle);
        expect(occupant.morale).toBe(100);
        expect(occupant.energy).toBe(100);
      }
    }
  });

  it("costs nothing on the wire once they are standing", () => {
    // The patch a tick sends when only the tick counter moved, for a room with
    // a given staff: the same size however many agents are standing.
    const tickPatchBytes = (count: number) => {
      const state = new OfficeState();
      hireAgentEmployees(state.occupants, OFFICE_LAYOUT, count);
      const encoder = new Encoder(state);
      encoder.encodeAll();
      encoder.discardChanges();
      state.tick += 1;
      return encoder.encode().length;
    };

    expect(tickPatchBytes(MAX_AGENT_COUNT)).toBe(tickPatchBytes(0));
  });
});
