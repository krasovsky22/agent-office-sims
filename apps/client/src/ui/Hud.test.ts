/**
 * The roster is one of the three places a player can tell a person from an
 * agent, and the only one that is text, so its grouping is pinned here.
 */

import { AGENT_ACTIVITY, MANAGER_STATUS, OCCUPANT_KIND } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { AGENT_ACTIVITY_APPEARANCE, MANAGER_STATUS_APPEARANCE } from "../agentActivity.js";

import { type RosterEntry, assignableRoster, groupRoster } from "./Hud.js";

function person(id: string, isCeo = false): RosterEntry {
  return {
    id,
    name: id,
    kind: OCCUPANT_KIND.human,
    isCeo,
    jobTitle: "",
    activity: undefined,
    salary: 0,
    isLocal: false,
    caption: "",
    taskUrl: "",
    assignedUrl: "",
    managerStatus: undefined,
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
    salary: 0,
    isLocal: false,
    caption: "",
    taskUrl: "",
    assignedUrl: "",
    managerStatus: undefined,
  };
}

function liveAgent(id: string): RosterEntry {
  return {
    id,
    name: id,
    kind: OCCUPANT_KIND.liveAgent,
    isCeo: false,
    jobTitle: "",
    activity: undefined,
    salary: 0,
    isLocal: false,
    caption: "Working on #33",
    taskUrl: "https://github.com/krasovsky22/agent-office-sims/issues/33",
    assignedUrl: "",
    managerStatus: undefined,
  };
}

function manager(): RosterEntry {
  return {
    ...person("manager:firstmate"),
    kind: OCCUPANT_KIND.manager,
    jobTitle: "AI Manager",
    managerStatus: MANAGER_STATUS.idle,
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

  it("lists live coding agents apart from both people and agent employees", () => {
    const { people, agents, liveAgents } = groupRoster([
      liveAgent("live-1"),
      person("Dana", true),
      agent("agent-1"),
    ]);
    expect(people.map((entry) => entry.id)).toEqual(["Dana"]);
    expect(agents.map((entry) => entry.id)).toEqual(["agent-1"]);
    expect(liveAgents.map((entry) => entry.id)).toEqual(["live-1"]);
  });

  it("leaves the agents group empty in a room with no staff", () => {
    expect(groupRoster([person("Dana")]).agents).toEqual([]);
  });

  it("lists the AI manager under a heading of its own", () => {
    const { people, agents, managers } = groupRoster([manager(), person("Dana", true), agent("agent-1")]);
    expect(managers.map((entry) => entry.id)).toEqual(["manager:firstmate"]);
    expect(people.map((entry) => entry.id)).toEqual(["Dana"]);
    expect(agents.map((entry) => entry.id)).toEqual(["agent-1"]);
  });
});

describe("assignableRoster", () => {
  it("offers everyone a ticket can go to, and never the manager", () => {
    expect(assignableRoster([manager(), person("Dana", true), agent("agent-1")]).map((entry) => entry.id)).toEqual([
      "Dana",
      "agent-1",
    ]);
  });
});

describe("MANAGER_STATUS_APPEARANCE", () => {
  it("names every status, and tells thinking from ready by colour", () => {
    const appearances = Object.values(MANAGER_STATUS).map((status) => MANAGER_STATUS_APPEARANCE[status]);
    expect(appearances.every((appearance) => appearance.label !== "")).toBe(true);
    expect(new Set(appearances.map((appearance) => appearance.colour)).size).toBe(appearances.length);
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
