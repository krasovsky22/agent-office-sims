/**
 * The roster is one of the three places a player can tell a person from an
 * agent, and the only one that is text, so its grouping is pinned here.
 */

import { MANAGER_STATUS, OCCUPANT_KIND } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { MANAGER_STATUS_APPEARANCE } from "../managerStatus.js";
import type { ConnectionStatus } from "../net/room.js";

import { type RosterEntry, assignableAgents, canRejoin, groupRoster, spendLine, statusLine } from "./Hud.js";

function person(id: string, isCeo = false): RosterEntry {
  return {
    id,
    name: id,
    kind: OCCUPANT_KIND.human,
    isCeo,
    isLocal: false,
    caption: "",
    needsInput: false,
    taskUrl: "",
    assignedUrl: "",
    canTakeIssues: false,
    title: "",
    description: "",
    profileEditable: false,
    managerStatus: undefined,
  };
}

function liveAgent(id: string, canTakeIssues = false): RosterEntry {
  return {
    id,
    name: id,
    kind: OCCUPANT_KIND.liveAgent,
    isCeo: false,
    isLocal: false,
    caption: "Working on #33",
    needsInput: false,
    taskUrl: "https://github.com/krasovsky22/agent-office-sims/issues/33",
    assignedUrl: "",
    canTakeIssues,
    title: "Software Developer",
    description: "",
    profileEditable: canTakeIssues,
    managerStatus: undefined,
  };
}

function manager(): RosterEntry {
  return {
    ...person("manager:firstmate"),
    kind: OCCUPANT_KIND.manager,
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

describe("spendLine", () => {
  it("shows the agents' spend against the budget, and warns once it is spent", () => {
    expect(spendLine({ runners: 1, spentUsd: 1.25, budgetUsd: 5, budgetSpent: false })).toEqual({ text: "Agents' spend: $1.25 of $5.00 today", spent: false });
    expect(spendLine({ runners: 1, spentUsd: 5.1, budgetUsd: 5, budgetSpent: true })).toEqual({
      text: "Agents' spend: $5.10 of $5.00 today — budget spent, no new starts",
      spent: true,
    });
    expect(spendLine({ runners: 2, spentUsd: 9, budgetUsd: undefined, budgetSpent: false })).toEqual({ text: "Agents' spend: $9.00 today, no budget", spent: false });
  });

  it("warns when one runner's own budget is spent, even while the runners together have room", () => {
    expect(spendLine({ runners: 2, spentUsd: 5, budgetUsd: 15, budgetSpent: true })).toEqual({
      text: "Agents' spend: $5.00 of $15.00 today — budget spent, no new starts",
      spent: true,
    });
  });
});

describe("statusLine", () => {
  it("says only that the office is full when a join is turned away", () => {
    expect(statusLine("full", undefined)).toBe("The office is full (16 people)");
  });

  it("keeps the unreachable-server wording for any other failure", () => {
    expect(statusLine("failed", "the server refused the connection")).toBe(
      "Could not reach the office server — the server refused the connection",
    );
  });
});

describe("canRejoin", () => {
  it("offers Rejoin only once the connection has stopped trying", () => {
    const stopped: ConnectionStatus[] = ["disconnected", "failed", "full"];
    const trying: ConnectionStatus[] = ["connecting", "connected", "reconnecting"];
    expect(stopped.every(canRejoin)).toBe(true);
    expect(trying.some(canRejoin)).toBe(false);
  });
});
