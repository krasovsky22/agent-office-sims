/**
 * The roster is one of the three places a player can tell a person from an
 * agent, and the only one that is text, so its grouping is pinned here.
 */

import { AGENT_ACTIVITY, OCCUPANT_KIND } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { AGENT_ACTIVITY_APPEARANCE } from "../agentActivity.js";

import { type RosterEntry, groupRoster } from "./Hud.js";

function person(id: string, isCeo = false): RosterEntry {
  return {
    id,
    name: id,
    kind: OCCUPANT_KIND.human,
    isCeo,
    jobTitle: "",
    activity: undefined,
    isLocal: false,
  };
}

function agent(id: string): RosterEntry {
  return {
    id,
    name: id,
    kind: OCCUPANT_KIND.agent,
    isCeo: false,
    jobTitle: "Backend Engineer",
    activity: AGENT_ACTIVITY.idle,
    isLocal: false,
  };
}

describe("groupRoster", () => {
  it("puts people and agents in separate groups, each in arrival order", () => {
    const { people, agents } = groupRoster([
      agent("agent-1"),
      person("Dana", true),
      agent("agent-2"),
      person("Milo"),
    ]);
    expect(people.map((entry) => entry.id)).toEqual(["Dana", "Milo"]);
    expect(agents.map((entry) => entry.id)).toEqual(["agent-1", "agent-2"]);
  });

  it("leaves the agents group empty in a room with no staff", () => {
    expect(groupRoster([person("Dana")]).agents).toEqual([]);
  });
});

describe("AGENT_ACTIVITY_APPEARANCE", () => {
  it("names every activity, and gives each its own colour", () => {
    const appearances = Object.values(AGENT_ACTIVITY).map(
      (activity) => AGENT_ACTIVITY_APPEARANCE[activity],
    );
    for (const appearance of appearances) {
      expect(appearance.label).not.toBe("");
    }
    expect(new Set(appearances.map((appearance) => appearance.colour)).size).toBe(
      appearances.length,
    );
  });
});
