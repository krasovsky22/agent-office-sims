/**
 * The manager's queue for the orchestrator: every assignment handed out by
 * exactly one collection, and shown on its agent until the agent reports
 * working on it.
 */

import { LIVE_AGENT_REPORT_STATUS } from "@sim/shared";
import { beforeEach, describe, expect, it } from "vitest";

import { LiveAgentRegistry } from "../agents/registry.js";
import { LIVE_ASSIGNMENT_STATUS, LiveAssignmentQueue, type LiveAssignmentRequest, toWire } from "./liveAssignments.js";

const ISSUE_39 = "https://github.com/o/r/issues/39";

function request(overrides: Partial<LiveAssignmentRequest> = {}): LiveAssignmentRequest {
  return {
    agentId: "crew-1",
    item: { kind: "issue", number: 39, title: "Night shift", url: ISSUE_39 },
    requestedBy: "Dana",
    note: "put crewmate on #39",
    origin: "room-a",
    ...overrides,
  };
}

let registry: LiveAgentRegistry;
let queue: LiveAssignmentQueue;

beforeEach(() => {
  registry = new LiveAgentRegistry({ timeoutMs: 60_000, maxAgents: 5 });
  registry.report({ id: "crew-1", name: "Crewmate", status: LIVE_AGENT_REPORT_STATUS.idle, task: undefined });
  queue = new LiveAssignmentQueue({ agents: registry, now: () => 1000 });
});

describe("LiveAssignmentQueue", () => {
  it("hands each assignment out exactly once", () => {
    const first = queue.assign(request());
    const second = queue.assign(request({ item: { kind: "pull", number: 40, title: "Fix", url: "https://github.com/o/r/pull/40" } }));
    expect(first?.id).toBe("assignment-1");
    expect(second?.id).toBe("assignment-2");

    const collected = queue.collect();
    expect(collected.map((assignment) => assignment.id)).toEqual(["assignment-1", "assignment-2"]);
    expect(collected.every((assignment) => assignment.status === LIVE_ASSIGNMENT_STATUS.collected)).toBe(true);
    expect(queue.collect()).toEqual([]);
  });

  it("sends the orchestrator what it needs and nothing about the room", () => {
    const assignment = queue.assign(request());
    if (assignment === undefined) {
      throw new Error("refused");
    }
    expect(toWire(assignment)).toEqual({
      id: "assignment-1",
      agentId: "crew-1",
      kind: "issue",
      number: 39,
      title: "Night shift",
      url: ISSUE_39,
      requestedBy: "Dana",
      note: "put crewmate on #39",
      assignedAt: 1000,
    });
  });

  it("shows the assignment on its agent until the agent reports working on it", () => {
    let changes = 0;
    queue.subscribe(() => {
      changes += 1;
    });
    queue.assign(request());
    expect(changes).toBe(1);
    expect(queue.current()).toEqual([
      expect.objectContaining({ id: "crew-1", assignment: { title: "Night shift", url: ISSUE_39 } }),
    ]);

    // Still shown once collected: the agent has not started it.
    queue.collect();
    expect(queue.current()[0]?.assignment?.url).toBe(ISSUE_39);

    // Working on the same issue, however the link is written, settles it.
    registry.report({
      id: "crew-1",
      name: "Crewmate",
      status: LIVE_AGENT_REPORT_STATUS.working,
      task: { title: "Night shift", url: "https://github.com/O/R/issues/39#top" },
    });
    expect(queue.current()[0]?.assignment).toBeUndefined();
    expect(queue.madeBy("room-a")[0]?.status).toBe(LIVE_ASSIGNMENT_STATUS.started);
  });

  it("keeps showing it while the agent works on something else", () => {
    queue.assign(request());
    registry.report({
      id: "crew-1",
      name: "Crewmate",
      status: LIVE_AGENT_REPORT_STATUS.working,
      task: { title: "Other", url: "https://github.com/o/r/issues/12" },
    });
    expect(queue.current()[0]?.assignment?.url).toBe(ISSUE_39);
  });

  it("refuses more once the orchestrator has fallen behind", () => {
    const small = new LiveAssignmentQueue({ agents: registry, maxPending: 2 });
    expect(small.assign(request())).toBeDefined();
    expect(small.assign(request())).toBeDefined();
    expect(small.assign(request())).toBeUndefined();
    small.collect();
    expect(small.assign(request())).toBeDefined();
  });

  it("tells each room only about its own manager's assignments", () => {
    queue.assign(request());
    queue.assign(request({ origin: "room-b" }));
    expect(queue.madeBy("room-a").map((assignment) => assignment.id)).toEqual(["assignment-1"]);
    expect(queue.madeBy("room-b").map((assignment) => assignment.id)).toEqual(["assignment-2"]);
  });

  it("forgets the oldest settled assignments past its cap, never a pending one", () => {
    const small = new LiveAssignmentQueue({ agents: registry, maxKept: 2 });
    small.assign(request());
    small.collect();
    small.assign(request());
    small.assign(request());
    expect(small.madeBy("room-a").map((assignment) => assignment.id)).toEqual(["assignment-2", "assignment-3"]);
    expect(small.collect()).toHaveLength(2);
  });

  it("stops following the registry once stopped", () => {
    queue.assign(request());
    queue.stop();
    registry.report({
      id: "crew-1",
      name: "Crewmate",
      status: LIVE_AGENT_REPORT_STATUS.working,
      task: { title: "Night shift", url: ISSUE_39 },
    });
    expect(queue.current()[0]?.assignment?.url).toBe(ISSUE_39);
  });
});
