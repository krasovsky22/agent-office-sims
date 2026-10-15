/**
 * Carrying out a plan's assignments against a real board: through the ticket
 * rules with the CEO as the actor, or onto the orchestrator's queue, and a
 * reason for every one that is refused.
 */

import {
  EMPTY_BOARD_LISTS,
  HumanPlayer,
  LIVE_AGENT_REPORT_STATUS,
  OFFICE_LAYOUT,
  OCCUPANT_KIND,
  OfficeState,
  PLAYER_ROLE,
  type ProjectBoardSnapshot,
  TICKET_STATUS,
  seedBoard,
} from "@sim/shared";
import { describe, expect, it } from "vitest";

import { LiveAgentRegistry } from "../agents/registry.js";
import { type TicketHost, createTicketIdFactory } from "../rooms/ticketHandlers.js";
import { hireAgentEmployees } from "../sim/agents.js";
import { type AssignContext, MAX_ASSIGNMENTS_PER_PLAN, carryOut } from "./assign.js";
import { LiveAssignmentQueue } from "./liveAssignments.js";
import { readOfficeView } from "./officeView.js";

const SNAPSHOT: ProjectBoardSnapshot = {
  ...EMPTY_BOARD_LISTS,
  repository: "o/r",
  updatedAt: 1,
  stale: false,
  open: [{ number: 39, title: "Night shift", labels: [], assignees: [], pullRequests: [], closedAt: null }],
  closed: [{ number: 12, title: "Old thing", labels: [], assignees: [], pullRequests: [], closedAt: 5 }],
};

function player(id: string, name: string, role: (typeof PLAYER_ROLE)[keyof typeof PLAYER_ROLE]): HumanPlayer {
  const occupant = new HumanPlayer();
  occupant.id = id;
  occupant.name = name;
  occupant.kind = OCCUPANT_KIND.human;
  occupant.role = role;
  return occupant;
}

/** Dana the CEO, Milo an executive, two agents, the starter board, and optionally an orchestrator. */
function office(options: { readonly orchestrator?: boolean } = {}) {
  const state = new OfficeState();
  const ceo = player("session-dana", "Dana", PLAYER_ROLE.ceo);
  const exec = player("session-milo", "Milo", PLAYER_ROLE.exec);
  state.occupants.set(ceo.id, ceo);
  state.occupants.set(exec.id, exec);
  hireAgentEmployees(state.occupants, OFFICE_LAYOUT, 2);
  const tickets: TicketHost = { state, now: () => 2000, nextTicketId: createTicketIdFactory() };
  seedBoard(state.tickets, 1000, tickets.nextTicketId);

  const registry = new LiveAgentRegistry({ timeoutMs: 60_000, maxAgents: 4 });
  registry.report({ id: "crew-1", name: "Crewmate", status: LIVE_AGENT_REPORT_STATUS.idle, task: undefined });
  const queue = options.orchestrator === false ? undefined : new LiveAssignmentQueue({ agents: registry });

  const context = (actor = ceo): AssignContext => ({
    tickets,
    ceo: actor,
    view: readOfficeView({ state, project: SNAPSHOT, liveAgents: queue?.current() }),
    queue,
    origin: "room-a",
    note: "do it",
  });
  return { state, ceo, exec, queue, context };
}

describe("carryOut: in-game tickets", () => {
  it("assigns a ticket to the named agent, through the board's rules", () => {
    const { state, context } = office();
    expect(carryOut([{ work: "ticket-1", agent: "Bo" }], context())).toEqual([
      "✓ ticket-1 “Fix the login redirect loop” → Bo Mendes, Frontend Engineer.",
    ]);
    expect(state.tickets.get("ticket-1")).toMatchObject({ status: TICKET_STATUS.assigned, assigneeId: "agent-2" });
  });

  it("spreads work for 'someone' across whoever has least on their plate", () => {
    const { state, context } = office();
    const lines = carryOut(
      [
        { work: "ticket-1", agent: "" },
        { work: "ticket-2", agent: "" },
        { work: "ticket-3", agent: "" },
      ],
      context(),
    );
    expect(lines.every((line) => line.startsWith("✓"))).toBe(true);
    expect(["ticket-1", "ticket-2", "ticket-3"].map((id) => state.tickets.get(id)?.assigneeId)).toEqual([
      "agent-1",
      "agent-2",
      "agent-1",
    ]);
  });

  it("acts with the authority of the CEO it acts for, and no more", () => {
    const { state, exec, context } = office();
    expect(carryOut([{ work: "ticket-1", agent: "Ada" }], context(exec))).toEqual([
      "✗ ticket-1 “Fix the login redirect loop”: only the CEO can assign tickets.",
    ]);
    expect(state.tickets.get("ticket-1")?.status).toBe(TICKET_STATUS.backlog);
  });

  it("refuses with a reason: unknown work, unknown agent, a live agent, finished work", () => {
    const { state, context } = office();
    const done = state.tickets.get("ticket-5");
    if (done !== undefined) {
      done.status = TICKET_STATUS.done;
      done.assigneeId = "agent-1";
    }
    expect(
      carryOut(
        [
          { work: "ticket-99", agent: "Ada" },
          { work: "ticket-1", agent: "Zed" },
          { work: "ticket-1", agent: "crew-1" },
          { work: "ticket-5", agent: "Bo" },
        ],
        context(),
      ),
    ).toEqual([
      "✗ ticket-99: I can't find that on the ticket board or the project board.",
      "✗ ticket-1 “Fix the login redirect loop”: nobody called Zed works here.",
      "✗ ticket-1 “Fix the login redirect loop”: Crewmate is a live coding agent, and in-game tickets go to the simulated staff.",
      "✗ ticket-5 “Draft the Q3 roadmap”: it is finished, and finished work keeps who did it.",
    ]);
  });

  it("stops after a plan's worth of assignments", () => {
    const { context } = office();
    const many = Array.from({ length: MAX_ASSIGNMENTS_PER_PLAN + 2 }, () => ({ work: "ticket-1", agent: "Ada" }));
    const lines = carryOut(many, context());
    expect(lines).toHaveLength(MAX_ASSIGNMENTS_PER_PLAN + 1);
    expect(lines.at(-1)).toContain(`stopped after ${MAX_ASSIGNMENTS_PER_PLAN}`);
  });
});

describe("carryOut: GitHub work for live agents", () => {
  it("queues an issue for the named live agent, and the orchestrator collects it", () => {
    const { queue, context } = office();
    expect(carryOut([{ work: "#39", agent: "Crewmate" }], context())).toEqual([
      "✓ #39 “Night shift” → Crewmate; queued for the orchestrator to hand over.",
    ]);
    expect(queue?.collect()).toEqual([
      expect.objectContaining({ agentId: "crew-1", requestedBy: "Dana", note: "do it", item: expect.objectContaining({ number: 39, url: "https://github.com/o/r/issues/39" }) }),
    ]);
  });

  it("picks a free live agent for 'someone', and refuses once none is free", () => {
    const { context } = office();
    expect(carryOut([{ work: "issue #39", agent: "" }], context())[0]).toContain("→ Crewmate");
    expect(carryOut([{ work: "#39", agent: "" }], context())[0]).toContain("every live agent is busy");
  });

  it("refuses with a reason: no orchestrator, a closed issue, simulated staff", () => {
    expect(carryOut([{ work: "#39", agent: "Crewmate" }], office({ orchestrator: false }).context())).toEqual([
      "✗ #39 “Night shift”: no agent orchestrator is connected, so I can't hand GitHub work to live agents.",
    ]);
    const { context } = office();
    expect(carryOut([{ work: "#12", agent: "Crewmate" }, { work: "#39", agent: "Ada" }], context())).toEqual([
      "✗ #12 “Old thing”: it is closed.",
      "✗ #39 “Night shift”: Ada Byrne is simulated staff; GitHub work goes to the live coding agents.",
    ]);
  });
});
