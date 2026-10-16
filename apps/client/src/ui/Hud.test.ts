/**
 * The roster is one of the three places a player can tell a person from an
 * agent, and the only one that is text, so its grouping is pinned here.
 */

import { MANAGER_STATUS, OCCUPANT_KIND } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { MANAGER_STATUS_APPEARANCE } from "../managerStatus.js";

import { type RosterEntry, assignableAgents, groupRoster } from "./Hud.js";

function person(id: string, isCeo = false): RosterEntry {
  return {
    id,
    name: id,
    kind: OCCUPANT_KIND.human,
    isCeo,
    isOperator: false,
    jobTitle: "",
    isLocal: false,
    caption: "",
    taskUrl: "",
    assignedUrl: "",
    canTakeIssues: false,
    managerStatus: undefined,
  };
}

function liveAgent(id: string, canTakeIssues = false): RosterEntry {
  return {
    id,
    name: id,
    kind: OCCUPANT_KIND.liveAgent,
    isCeo: false,
    isOperator: false,
    jobTitle: "",
    isLocal: false,
    caption: "Working on #33",
    taskUrl: "https://github.com/krasovsky22/agent-office-sims/issues/33",
    assignedUrl: "",
    canTakeIssues,
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
  it("puts people and live coding agents in separate groups, each in arrival order", () => {
    const { people, liveAgents } = groupRoster([
      liveAgent("live-1"),
      person("Dana", true),
      liveAgent("live-2"),
      person("Milo"),
    ]);
    expect(people.map((entry) => entry.id)).toEqual(["Dana", "Milo"]);
    expect(liveAgents.map((entry) => entry.id)).toEqual(["live-1", "live-2"]);
  });

  it("lists the AI manager under a heading of its own", () => {
    const { people, liveAgents, managers } = groupRoster([manager(), person("Dana", true), liveAgent("live-1")]);
    expect(managers.map((entry) => entry.id)).toEqual(["manager:firstmate"]);
    expect(people.map((entry) => entry.id)).toEqual(["Dana"]);
    expect(liveAgents.map((entry) => entry.id)).toEqual(["live-1"]);
  });
});

describe("assignableAgents", () => {
  it("offers an issue only to a live agent that can take issues, never a player or the manager", () => {
    const roster = [manager(), person("Dana", true), liveAgent("agent:reporter"), liveAgent("agent:r/s1", true)];
    expect(assignableAgents(roster).map((entry) => entry.id)).toEqual(["agent:r/s1"]);
  });
});

describe("MANAGER_STATUS_APPEARANCE", () => {
  it("names every status, and tells thinking from ready by colour", () => {
    const appearances = Object.values(MANAGER_STATUS).map((status) => MANAGER_STATUS_APPEARANCE[status]);
    expect(appearances.every((appearance) => appearance.label !== "")).toBe(true);
    expect(new Set(appearances.map((appearance) => appearance.colour)).size).toBe(appearances.length);
  });
});
