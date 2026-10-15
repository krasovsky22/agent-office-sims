/**
 * What counts as news to the manager between two looks at the office, for the
 * live agents and the orchestrator; the in-game board's news is shown end to
 * end in `officeManager.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { LIVE_ASSIGNMENT_STATUS, type LiveAssignment, type LiveAssignmentStatus } from "./liveAssignments.js";
import type { LiveAgentView, OfficeView } from "./officeView.js";
import { describeChanges, observe } from "./updates.js";

const ISSUE_33 = { title: "Live agents", url: "https://github.com/o/r/issues/33", reference: "#33" };

function view(liveAgents: readonly LiveAgentView[]): OfficeView {
  return { ceo: "Dana", agents: [], liveAgents, tickets: [], project: undefined, orchestrator: true };
}

function crewmate(status: LiveAgentView["status"], task = status === "working" ? ISSUE_33 : undefined): LiveAgentView {
  return { id: "crew-1", name: "Crewmate", status, task, assigned: undefined };
}

function assignment(status: LiveAssignmentStatus): LiveAssignment {
  return {
    id: "assignment-1",
    agentId: "crew-1",
    item: { kind: "issue", number: 39, title: "Night shift", url: "https://github.com/o/r/issues/39" },
    requestedBy: "Dana",
    note: "",
    origin: "room-a",
    assignedAt: 0,
    status,
  };
}

describe("describeChanges", () => {
  it("says when a live agent comes in, starts, stops, and leaves", () => {
    const nobody = observe(view([]), []);
    const idle = observe(view([crewmate("idle")]), []);
    const working = observe(view([crewmate("working")]), []);
    expect(describeChanges(nobody, idle)).toEqual(["Crewmate came in."]);
    expect(describeChanges(idle, working)).toEqual(["Crewmate started on #33 “Live agents”."]);
    expect(describeChanges(working, idle)).toEqual(["Crewmate stopped working on #33 “Live agents” and is free."]);
    expect(describeChanges(idle, nobody)).toEqual(["Crewmate left the office."]);
    expect(describeChanges(working, observe(view([crewmate("working")]), []))).toEqual([]);
  });

  it("says when the orchestrator picks an assignment up, even one made since the last look", () => {
    const agents = view([crewmate("idle")]);
    const pending = observe(agents, [assignment(LIVE_ASSIGNMENT_STATUS.pending)]);
    const collected = observe(agents, [assignment(LIVE_ASSIGNMENT_STATUS.collected)]);
    const line = "The orchestrator picked up #39 “Night shift” for Crewmate.";
    expect(describeChanges(pending, collected)).toEqual([line]);
    expect(describeChanges(observe(agents, []), collected)).toEqual([line]);
    expect(describeChanges(collected, collected)).toEqual([]);
  });
});
