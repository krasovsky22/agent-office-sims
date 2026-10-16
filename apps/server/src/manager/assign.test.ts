/**
 * Carrying out a plan's assignments against a real office and project board:
 * issues to agent employees through the work rules with the CEO as the actor,
 * or onto the orchestrator's queue for a live agent, and a reason for every
 * one that is refused.
 */

import {
  type BoardIssue,
  EMPTY_BOARD_LISTS,
  HumanPlayer,
  IssueWork,
  LIVE_AGENT_REPORT_STATUS,
  OFFICE_LAYOUT,
  OCCUPANT_KIND,
  OfficeState,
  PLAYER_ROLE,
  type ProjectBoardSnapshot,
  WORK_STATUS,
  workKey,
} from "@sim/shared";
import { describe, expect, it } from "vitest";

import { LiveAgentRegistry } from "../agents/registry.js";
import type { WorkHost } from "../rooms/workHandlers.js";
import { hireAgentEmployees } from "../sim/agents.js";
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

/** Dana the CEO, Milo an executive, two agents, the project board, and optionally an orchestrator. */
function office(options: { readonly orchestrator?: boolean; readonly agents?: number } = {}) {
  const state = new OfficeState();
  const ceo = player("session-dana", "Dana", PLAYER_ROLE.ceo);
  const exec = player("session-milo", "Milo", PLAYER_ROLE.exec);
  state.occupants.set(ceo.id, ceo);
  state.occupants.set(exec.id, exec);
  hireAgentEmployees(state.occupants, OFFICE_LAYOUT, options.agents ?? 2);
  const work: WorkHost = { state, now: () => 2000, board: () => SNAPSHOT };

  const registry = new LiveAgentRegistry({ timeoutMs: 60_000, maxAgents: 4 });
  registry.report({ id: "crew-1", name: "Crewmate", status: LIVE_AGENT_REPORT_STATUS.idle, task: undefined });
  const queue = options.orchestrator === false ? undefined : new LiveAssignmentQueue({ agents: registry });

  const context = (actor = ceo): AssignContext => ({
    work,
    ceo: actor,
    view: readOfficeView({ state, project: SNAPSHOT, liveAgents: queue?.current() }),
    queue,
    origin: "room-a",
    note: "do it",
  });
  return { state, ceo, exec, queue, context };
}

describe("carryOut: issues for agent employees", () => {
  it("gives an issue to the named agent, through the work's rules", () => {
    const { state, context } = office();
    expect(carryOut([{ work: "#10", agent: "Bo" }], context())).toEqual([
      "✓ #10 “Fix the login redirect loop” → Bo Mendes, Frontend Engineer.",
    ]);
    expect(state.work.get(workKey(10))).toMatchObject({
      status: WORK_STATUS.assigned,
      assigneeId: "agent-2",
      title: "Fix the login redirect loop",
    });
  });

  it("spreads work for 'someone' across whoever has least on their plate", () => {
    const { state, context } = office();
    const lines = carryOut(
      [
        { work: "#10", agent: "" },
        { work: "issue #11", agent: "" },
        { work: "15", agent: "" },
      ],
      context(),
    );
    expect(lines.every((line) => line.startsWith("✓"))).toBe(true);
    expect([10, 11, 15].map((number) => state.work.get(workKey(number))?.assigneeId)).toEqual([
      "agent-1",
      "agent-2",
      "agent-1",
    ]);
  });

  it("says who an issue was taken from when it changes hands", () => {
    const { context } = office();
    carryOut([{ work: "#10", agent: "Ada" }], context());
    expect(carryOut([{ work: "#10", agent: "Bo" }], context())).toEqual([
      "✓ #10 “Fix the login redirect loop” → Bo Mendes, Frontend Engineer (from Ada Byrne).",
    ]);
    expect(carryOut([{ work: "#10", agent: "Bo" }], context())).toEqual(["• #10 “Fix the login redirect loop” is already Bo Mendes's."]);
  });

  it("acts with the authority of the CEO it acts for, and no more", () => {
    const { state, exec, context } = office();
    expect(carryOut([{ work: "#10", agent: "Ada" }], context(exec))).toEqual([
      "✗ #10 “Fix the login redirect loop”: only the CEO can hand out work.",
    ]);
    expect(state.work.size).toBe(0);
  });

  it("refuses with a reason: unknown work, unknown agent, a pull request, finished work, a closed issue", () => {
    const { state, context } = office();
    const done = new IssueWork();
    done.issueNumber = 15;
    done.title = "Draft the Q3 roadmap";
    done.status = WORK_STATUS.done;
    done.assigneeId = "agent-1";
    state.work.set(workKey(15), done);
    expect(
      carryOut(
        [
          { work: "#99", agent: "Ada" },
          { work: "#10", agent: "Zed" },
          { work: "PR #46", agent: "Bo" },
          { work: "#15", agent: "Bo" },
          { work: "#12", agent: "Bo" },
        ],
        context(),
      ),
    ).toEqual([
      "✗ #99: I can't find that on the project board.",
      "✗ #10 “Fix the login redirect loop”: nobody called Zed works here.",
      "✗ PR #46 “Show live agents”: Bo Mendes is simulated staff and works issues; pull requests go to the live coding agents.",
      "✗ #15 “Draft the Q3 roadmap”: it is finished, and finished work keeps who did it.",
      "✗ #12 “Old thing”: it is closed.",
    ]);
  });

  it("stops after a plan's worth of assignments", () => {
    const { context } = office();
    const many = Array.from({ length: MAX_ASSIGNMENTS_PER_PLAN + 2 }, () => ({ work: "#10", agent: "Ada" }));
    const lines = carryOut(many, context());
    expect(lines).toHaveLength(MAX_ASSIGNMENTS_PER_PLAN + 1);
    expect(lines.at(-1)).toContain(`stopped after ${MAX_ASSIGNMENTS_PER_PLAN}`);
  });
});

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

  it("gives an issue for 'someone' to a live agent only in an office with no employees", () => {
    const { state, context } = office({ agents: 0 });
    expect(carryOut([{ work: "#39", agent: "" }], context())[0]).toContain("→ Crewmate; queued");
    expect(state.work.size).toBe(0);
  });

  it("refuses with a reason when no orchestrator is connected", () => {
    const { context } = office({ orchestrator: false });
    expect(carryOut([{ work: "#39", agent: "Crewmate" }, { work: "PR #46", agent: "" }], context())).toEqual([
      "✗ #39 “Night shift”: nobody called Crewmate works here.",
      "✗ PR #46 “Show live agents”: pull requests go to live coding agents, and no agent orchestrator is connected.",
    ]);
  });
});
