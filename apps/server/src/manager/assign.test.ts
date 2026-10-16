/**
 * Carrying out a plan's assignments against a real office and project board:
 * through the work rules for a live agent that can take issues, onto the
 * orchestrator's queue for one of its agents, and a reason for every one that
 * is refused.
 */

import {
  type BoardIssue,
  EMPTY_BOARD_LISTS,
  HumanPlayer,
  LIVE_AGENT_REPORT_STATUS,
  LiveAgent,
  OCCUPANT_KIND,
  OfficeState,
  PLAYER_ROLE,
  type ProjectBoardSnapshot,
  WORK_STATUS,
  workKey,
} from "@sim/shared";
import { describe, expect, it } from "vitest";

import { LiveAgentRegistry } from "../agents/registry.js";
import { type AssignContext, MAX_ASSIGNMENTS_PER_PLAN, carryOut } from "./assign.js";
import { LiveAssignmentQueue } from "./liveAssignments.js";
import { readOfficeView } from "./officeView.js";

function issue(number: number, title: string, closedAt: number | null = null): BoardIssue {
  return { number, title, body: "", labels: [], assignees: [], pullRequests: [], closedAt };
}

const SNAPSHOT: ProjectBoardSnapshot = {
  ...EMPTY_BOARD_LISTS,
  repository: "o/r",
  updatedAt: 1,
  stale: false,
  open: [issue(10, "Fix the login redirect loop"), issue(11, "Write the onboarding email"), issue(15, "Draft the Q3 roadmap"), issue(39, "Night shift")],
  closed: [issue(12, "Old thing", 5)],
  pullRequests: [{ number: 46, title: "Show live agents", labels: [], author: "crew", draft: false, checks: "unknown" }],
  counts: { open: 4, inProgress: 0, pullRequests: 1 },
};

function player(id: string, name: string, role: (typeof PLAYER_ROLE)[keyof typeof PLAYER_ROLE]): HumanPlayer {
  const occupant = new HumanPlayer();
  occupant.id = id;
  occupant.name = name;
  occupant.kind = OCCUPANT_KIND.human;
  occupant.role = role;
  return occupant;
}

function liveAgent(id: string, name: string, canTakeIssues: boolean): LiveAgent {
  const occupant = new LiveAgent();
  occupant.id = id;
  occupant.name = name;
  occupant.canTakeIssues = canTakeIssues;
  return occupant;
}

/**
 * Dana the CEO, the project board, optionally an orchestrator with one live
 * agent, and the live agents on the floor that can take issues.
 */
function office(options: { readonly orchestrator?: boolean; readonly takers?: readonly string[] } = {}) {
  const state = new OfficeState();
  const ceo = player("session-dana", "Dana", PLAYER_ROLE.ceo);
  state.occupants.set(ceo.id, ceo);
  for (const name of options.takers ?? []) {
    const taker = liveAgent(`agent:runner/${name}`, name, true);
    state.occupants.set(taker.id, taker);
  }

  const registry = new LiveAgentRegistry({ timeoutMs: 60_000, maxAgents: 4 });
  registry.report({ id: "crew-1", name: "Crewmate", status: LIVE_AGENT_REPORT_STATUS.idle, task: undefined });
  const queue = options.orchestrator === false ? undefined : new LiveAssignmentQueue({ agents: registry });

  const context = (actor = ceo): AssignContext => ({
    work: { state, now: () => 100, board: () => SNAPSHOT },
    ceo: actor,
    view: readOfficeView({ state, project: SNAPSHOT, liveAgents: queue?.current() }),
    queue,
    origin: "room-a",
    note: "do it",
  });
  return { state, ceo, queue, context };
}

describe("carryOut: GitHub work for live agents", () => {
  it("queues an issue for the named live agent, and the orchestrator collects it", () => {
    const { state, queue, context } = office();
    expect(carryOut([{ work: "#39", agent: "Crewmate" }], context())).toEqual([
      "✓ #39 “Night shift” → Crewmate; queued for the orchestrator to hand over.",
    ]);
    expect(queue?.collect()).toEqual([
      expect.objectContaining({ agentId: "crew-1", requestedBy: "Dana", note: "do it", item: expect.objectContaining({ number: 39, url: "https://github.com/o/r/issues/39" }) }),
    ]);
    expect(state.work.size).toBe(0);
  });

  it("queues a pull request for 'someone' with a free live agent, and refuses once none is free", () => {
    const { context } = office();
    expect(carryOut([{ work: "PR #46", agent: "" }], context())[0]).toContain("→ Crewmate");
    expect(carryOut([{ work: "PR #46", agent: "" }], context())[0]).toContain("every live agent is busy");
  });

  it("gives an issue for 'someone' to a free live agent", () => {
    const { state, context } = office();
    expect(carryOut([{ work: "#39", agent: "" }], context())[0]).toContain("→ Crewmate; queued");
    expect(state.work.size).toBe(0);
  });

  it("refuses with a reason: unknown work, unknown agent, a closed issue", () => {
    const { context } = office();
    expect(
      carryOut(
        [
          { work: "#99", agent: "Crewmate" },
          { work: "#10", agent: "Zed" },
          { work: "#12", agent: "Crewmate" },
        ],
        context(),
      ),
    ).toEqual([
      "✗ #99: I can't find that on the project board.",
      "✗ #10 “Fix the login redirect loop”: nobody called Zed works here.",
      "✗ #12 “Old thing”: it is closed.",
    ]);
  });

  it("stops after a plan's worth of assignments", () => {
    const { context } = office();
    const many = Array.from({ length: MAX_ASSIGNMENTS_PER_PLAN + 2 }, () => ({ work: "#10", agent: "Crewmate" }));
    const lines = carryOut(many, context());
    expect(lines).toHaveLength(MAX_ASSIGNMENTS_PER_PLAN + 1);
    expect(lines.at(-1)).toContain(`stopped after ${MAX_ASSIGNMENTS_PER_PLAN}`);
  });

  it("refuses with a reason when no orchestrator is connected", () => {
    const { context } = office({ orchestrator: false });
    expect(carryOut([{ work: "#39", agent: "Crewmate" }, { work: "PR #46", agent: "" }], context())).toEqual([
      "✗ #39 “Night shift”: nobody called Crewmate works here.",
      "✗ PR #46 “Show live agents”: pull requests go to live coding agents, and no agent orchestrator is connected.",
    ]);
  });
});

describe("carryOut: an office with an operator passphrase", () => {
  it("refuses a CEO who has not verified as operator, with the reason, and queues nothing", () => {
    const { state, queue, context } = office();
    state.operatorRequired = true;
    expect(carryOut([{ work: "#39", agent: "Crewmate" }, { work: "PR #46", agent: "" }], context())).toEqual([
      "✗ #39 “Night shift”: only a verified operator can send work to live coding agents; verify with the operator passphrase first.",
      "✗ PR #46 “Show live agents”: only a verified operator can send work to live coding agents; verify with the operator passphrase first.",
    ]);
    expect(queue?.collect()).toEqual([]);
  });

  it("queues work for a CEO who has", () => {
    const { state, ceo, context } = office();
    state.operatorRequired = true;
    ceo.operator = true;
    expect(carryOut([{ work: "#39", agent: "Crewmate" }], context())[0]).toContain("→ Crewmate; queued");
  });
});

describe("carryOut: issues for live agents that can take them", () => {
  it("gives an issue to the named agent through the work rules, as the CEO", () => {
    const { state, queue, context } = office({ takers: ["Slot 1"] });
    expect(carryOut([{ work: "#39", agent: "Slot 1" }], context())).toEqual(["✓ #39 “Night shift” → Slot 1."]);
    expect(state.work.get(workKey(39))).toMatchObject({
      status: WORK_STATUS.assigned,
      assigneeId: "agent:runner/Slot 1",
      assignedAt: 100,
    });
    expect(queue?.collect()).toEqual([]);
    expect(carryOut([{ work: "#39", agent: "Slot 1" }], context())).toEqual(["• #39 “Night shift” is already Slot 1's."]);
  });

  it("spreads issues for 'someone' across the agents that take them, before the orchestrator's", () => {
    const { state, queue, context } = office({ takers: ["Slot 1", "Slot 2"] });
    expect(carryOut([{ work: "#10", agent: "" }, { work: "#11", agent: "" }, { work: "#15", agent: "" }], context())).toEqual([
      "✓ #10 “Fix the login redirect loop” → Slot 1.",
      "✓ #11 “Write the onboarding email” → Slot 2.",
      "✓ #15 “Draft the Q3 roadmap” → Slot 1.",
    ]);
    expect(carryOut([{ work: "#10", agent: "" }], context())).toEqual([
      "✓ #10 “Fix the login redirect loop” → Slot 2 (from Slot 1).",
    ]);
    expect(state.work.size).toBe(3);
    expect(queue?.collect()).toEqual([]);
  });

  it("still queues an issue for an orchestrator's agent the CEO names", () => {
    const { state, context } = office({ takers: ["Slot 1"] });
    expect(carryOut([{ work: "#39", agent: "Crewmate" }], context())[0]).toContain("→ Crewmate; queued");
    expect(state.work.size).toBe(0);
  });

  it("refuses a pull request for an agent that takes issues, and an assignment by anyone but the CEO", () => {
    const { state, context } = office({ takers: ["Slot 1"] });
    expect(carryOut([{ work: "PR #46", agent: "Slot 1" }], context())).toEqual([
      "✗ PR #46 “Show live agents”: pull requests go to the orchestrator's agents, and Slot 1 is not one of them.",
    ]);
    const exec = player("session-milo", "Milo", PLAYER_ROLE.exec);
    state.occupants.set(exec.id, exec);
    expect(carryOut([{ work: "#39", agent: "Slot 1" }], context(exec))).toEqual([
      "✗ #39 “Night shift”: only the CEO can hand out work.",
    ]);
    expect(state.work.size).toBe(0);
  });

  it("never gives an issue to a live agent on the floor that cannot take one", () => {
    const { state, context } = office();
    const reporter = liveAgent("agent:reporter", "Reporter", false);
    state.occupants.set(reporter.id, reporter);
    expect(carryOut([{ work: "#39", agent: "Reporter" }], context())).toEqual([
      "✗ #39 “Night shift”: nobody called Reporter works here.",
    ]);
    expect(state.work.size).toBe(0);
  });
});
