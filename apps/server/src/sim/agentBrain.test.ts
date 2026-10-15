/**
 * The brain is tested the way the room runs it: real schema state on the
 * shipped floor plan, the real intent queue and body stepped by a 20Hz tick,
 * and the board's real rules — with the clock faked, so a cycle that takes
 * twenty seconds of walking and working runs in milliseconds. The work
 * executor is scripted, so each test decides when, and how, the work ends.
 */

import {
  AGENT_ACTIVITY,
  ANIMATION_STATE,
  type AgentEmployee,
  OFFICE_LAYOUT,
  OfficeState,
  TICKET_ACTION,
  TICKET_STATUS,
  TICK_INTERVAL_MS,
  type Ticket,
  type TicketCommand,
  type Vec2,
  applyTicketCommand,
  deskStand,
  ticketBoardStand,
} from "@sim/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type TicketHost, createTicketIdFactory, seedTicketBoard } from "../rooms/ticketHandlers.js";
import { WORK_FAILURE, type WorkContext, type WorkExecutor, type WorkResult, type WorkTicket } from "../work/executor.js";
import { AgentBrain, BRAIN_POLL_MS } from "./agentBrain.js";
import { AgentMotion } from "./agentMotion.js";
import { hireAgentEmployees } from "./agents.js";
import { HoldRegistry, type InteractionHost } from "./interaction.js";
import { type OccupantMotion } from "./movement.js";

/** The CEO, as the board's rules judge one; the brain's commands are the agents'. */
const CEO = { id: "session-ceo", kind: "human", isCeo: true } as const;

/** One work call the scripted executor is holding open. */
interface Call {
  readonly ticket: WorkTicket;
  readonly context: WorkContext;
  readonly signal: AbortSignal | undefined;
  readonly finish: (result: WorkResult) => void;
}

function scriptedExecutor(): { readonly executor: WorkExecutor; readonly calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    executor: {
      work: (ticket, context, signal) =>
        new Promise<WorkResult>((finish) => {
          calls.push({ ticket, context, signal, finish });
        }),
    },
  };
}

function success(artifact: string): WorkResult {
  return { ok: true, artifact, summary: "A deliverable", tokensUsed: 0, attempts: 1 };
}

function failure(message: string): WorkResult {
  return {
    ok: false,
    reason: WORK_FAILURE.budgetExhausted,
    message,
    tokensUsed: 0,
    attempts: 0,
    retryAt: undefined,
  };
}

interface Office {
  readonly state: OfficeState;
  readonly agents: AgentEmployee[];
  readonly brains: AgentBrain[];
  readonly calls: Call[];
  readonly ticks: () => number;
  /** Runs a command as the CEO. */
  readonly ceo: (command: TicketCommand) => void;
  readonly ticket: (id: string) => Ticket;
  /** Stops the tick, as a closing room does. */
  readonly closeTick: () => void;
}

let logged: string[];

beforeEach(() => {
  vi.useFakeTimers();
  logged = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => void logged.push(line));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A room's worth of agents with brains, a board, and a running tick. */
function openOffice(agentCount = 1): Office {
  const state = new OfficeState();
  const agents = hireAgentEmployees(state.occupants, OFFICE_LAYOUT, agentCount);
  const interaction: InteractionHost = {
    layout: OFFICE_LAYOUT,
    occupants: state.occupants,
    motions: new Map<string, OccupantMotion>(),
    holds: new HoldRegistry(),
    lastUsedAt: new Map(),
  };
  const motion = new AgentMotion(interaction);
  const tickets: TicketHost = { state, now: () => Date.now(), nextTicketId: createTicketIdFactory() };
  seedTicketBoard(tickets);

  let now = 0;
  let ticks = 0;
  const tick = setInterval(() => {
    now += TICK_INTERVAL_MS;
    ticks += 1;
    motion.step(now);
  }, TICK_INTERVAL_MS);

  const { executor, calls } = scriptedExecutor();
  const host = { tickets, layout: OFFICE_LAYOUT, motion, executor, clockNow: () => now };
  const brains = agents.map((agent) => new AgentBrain(host, agent.id));
  brains.forEach((brain) => brain.start());

  return {
    state,
    agents,
    brains,
    calls,
    ticks: () => ticks,
    ceo: (command) => {
      const result = applyTicketCommand(command, {
        board: state.tickets,
        occupants: state.occupants,
        actor: CEO,
        now: Date.now(),
        nextTicketId: tickets.nextTicketId,
      });
      expect(result.ok, command.action).toBe(true);
    },
    ticket: (id) => {
      const ticket = state.tickets.get(id);
      if (ticket === undefined) {
        throw new Error(`no ticket ${id}`);
      }
      return ticket;
    },
    closeTick: () => clearInterval(tick),
  };
}

function agentAt(office: Office, index: number): AgentEmployee {
  const agent = office.agents[index];
  if (agent === undefined) {
    throw new Error(`no agent ${index}`);
  }
  return agent;
}

function assign(office: Office, ticketId: string, agent: AgentEmployee): void {
  office.ceo({ action: TICKET_ACTION.assign, payload: { ticketId, assigneeId: agent.id } });
}

/** Lets the clock run, a tick at a time, until `ready` holds. */
async function until(ready: () => boolean, limitMs = 60_000): Promise<void> {
  for (let waited = 0; !ready(); waited += TICK_INTERVAL_MS) {
    if (waited > limitMs) {
      throw new Error("the office never got there");
    }
    await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS);
  }
}

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

describe("a full cycle", () => {
  it("claims, works at the desk, carries the work to the board, and goes home", async () => {
    const office = openOffice();
    const ada = agentAt(office, 0);
    const home = deskStand(OFFICE_LAYOUT, ada.deskId);
    const board = ticketBoardStand(OFFICE_LAYOUT);
    if (home === undefined || board === undefined) {
      throw new Error("the layout has no desk or no board for Ada");
    }

    assign(office, "ticket-1", ada);
    await until(() => office.ticket("ticket-1").status === TICKET_STATUS.in_progress);
    expect(ada.currentTicketId).toBe("ticket-1");

    // At the desk, seated and typing, with the work under way.
    await until(() => office.calls.length === 1);
    expect(ada.interactableId).not.toBe("");
    expect(ada.animation).toBe(ANIMATION_STATE.typing);
    expect(ada.activity).toBe(AGENT_ACTIVITY.working);
    expect(office.calls[0]?.ticket.id).toBe("ticket-1");
    expect(office.calls[0]?.context).toEqual({ agentName: ada.name, jobTitle: ada.jobTitle });

    // However long the work takes, the body stays put.
    const seatedAt = { x: ada.x, z: ada.z };
    await vi.advanceTimersByTimeAsync(10_000);
    expect(distance(ada, seatedAt)).toBe(0);
    expect(office.ticket("ticket-1").status).toBe(TICKET_STATUS.in_progress);

    office.calls[0]?.finish(success("# Spec\nThe deliverable."));
    await until(() => office.ticket("ticket-1").outputArtifact !== "");
    // Written at the desk; handed in only at the board.
    expect(office.ticket("ticket-1").status).toBe(TICKET_STATUS.in_progress);

    await until(() => ada.activity === AGENT_ACTIVITY.walking);
    await until(() => office.ticket("ticket-1").status === TICKET_STATUS.review);
    expect(distance(ada, board)).toBeLessThan(0.2);
    expect(office.ticket("ticket-1").outputArtifact).toBe("# Spec\nThe deliverable.");
    expect(office.ticket("ticket-1").assigneeId).toBe(ada.id);
    expect(ada.currentTicketId).toBe("");

    await until(() => distance(ada, home) < 0.2 && ada.activity === AGENT_ACTIVITY.idle);
    expect(ada.animation).toBe(ANIMATION_STATE.idle);
    expect(logged.filter((line) => line.includes("agent-work"))).toEqual([
      expect.stringContaining('"step":"claimed"'),
      expect.stringContaining('"step":"attached"'),
      expect.stringContaining('"step":"handed-in"'),
    ]);
  });

  it("only ever takes tickets the CEO assigned to it", async () => {
    const office = openOffice(2);
    const bo = agentAt(office, 1);
    assign(office, "ticket-1", bo);

    await until(() => office.calls.length === 1);
    await vi.advanceTimersByTimeAsync(5 * BRAIN_POLL_MS);
    expect(office.calls).toHaveLength(1);
    expect(agentAt(office, 0).currentTicketId).toBe("");
    expect(bo.currentTicketId).toBe("ticket-1");
    // The backlog stays the CEO's to hand out.
    expect(office.ticket("ticket-2").status).toBe(TICKET_STATUS.backlog);
  });

  it("does rework sent back from review", async () => {
    const office = openOffice();
    const ada = agentAt(office, 0);
    assign(office, "ticket-1", ada);
    await until(() => office.calls.length === 1);
    office.calls[0]?.finish(success("First draft."));
    await until(() => office.ticket("ticket-1").status === TICKET_STATUS.review);

    office.ceo({
      action: TICKET_ACTION.moveStatus,
      payload: { ticketId: "ticket-1", status: TICKET_STATUS.in_progress },
    });
    await until(() => office.calls.length === 2);
    office.calls[1]?.finish(success("Second draft."));
    await until(() => office.ticket("ticket-1").status === TICKET_STATUS.review);
    expect(office.ticket("ticket-1").outputArtifact).toBe("Second draft.");
  });
});

describe("every agent at once", () => {
  it("keeps the tick running at full rate while every agent waits on its work", async () => {
    const office = openOffice(4);
    office.agents.forEach((agent, index) => assign(office, `ticket-${index + 1}`, agent));
    await until(() => office.calls.length === 4);

    const before = office.ticks();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(office.ticks() - before).toBe(10_000 / TICK_INTERVAL_MS);
    for (const agent of office.agents) {
      expect(agent.activity, agent.name).toBe(AGENT_ACTIVITY.working);
      expect(agent.animation, agent.name).toBe(ANIMATION_STATE.typing);
    }

    office.calls.forEach((call) => call.finish(success(`Done: ${call.ticket.title}`)));
    await until(() =>
      [1, 2, 3, 4].every((n) => office.ticket(`ticket-${n}`).status === TICKET_STATUS.review),
    );
    for (const [index, agent] of office.agents.entries()) {
      expect(office.ticket(`ticket-${index + 1}`).assigneeId).toBe(agent.id);
    }
  });

  it("never has two agents working one ticket, even when it changes hands mid-work", async () => {
    const office = openOffice(2);
    const ada = agentAt(office, 0);
    const bo = agentAt(office, 1);
    assign(office, "ticket-1", ada);
    await until(() => office.calls.length === 1);

    assign(office, "ticket-1", bo);
    let both = false;
    const watch = setInterval(() => {
      both ||= ada.currentTicketId === "ticket-1" && bo.currentTicketId === "ticket-1";
    }, 10);

    // Ada finishes after the reassignment: her work is not Bo's ticket's any more.
    office.calls[0]?.finish(success("Ada's draft."));
    await until(() => office.calls.length === 2);
    expect(office.calls[1]?.context.agentName).toBe(bo.name);
    expect(ada.currentTicketId).toBe("");
    expect(office.ticket("ticket-1").outputArtifact).toBe("");

    office.calls[1]?.finish(success("Bo's draft."));
    await until(() => office.ticket("ticket-1").status === TICKET_STATUS.review);
    clearInterval(watch);
    expect(both).toBe(false);
    expect(office.ticket("ticket-1").outputArtifact).toBe("Bo's draft.");
  });
});

describe("a failed work call", () => {
  it("blocks the agent, keeps the ticket, says why, and recovers when the CEO retries", async () => {
    const office = openOffice();
    const ada = agentAt(office, 0);
    assign(office, "ticket-1", ada);
    await until(() => office.calls.length === 1);

    office.calls[0]?.finish(failure("agent call budget for today is spent"));
    await until(() => ada.activity === AGENT_ACTIVITY.blocked);

    const ticket = office.ticket("ticket-1");
    expect(ticket.status).toBe(TICKET_STATUS.in_progress);
    expect(ticket.assigneeId).toBe(ada.id);
    expect(ada.currentTicketId).toBe("ticket-1");
    const comment = ticket.comments.at(-1);
    expect(comment?.authorId).toBe(ada.id);
    expect(comment?.text).toContain("agent call budget for today is spent");

    // Left alone, it stays blocked and makes no further call.
    await vi.advanceTimersByTimeAsync(10 * BRAIN_POLL_MS);
    expect(ada.activity).toBe(AGENT_ACTIVITY.blocked);
    expect(office.calls).toHaveLength(1);

    office.ceo({
      action: TICKET_ACTION.moveStatus,
      payload: { ticketId: "ticket-1", status: TICKET_STATUS.assigned },
    });
    await until(() => office.calls.length === 2);
    office.calls[1]?.finish(success("Second attempt."));
    await until(() => office.ticket("ticket-1").status === TICKET_STATUS.review);
    expect(ada.activity).not.toBe(AGENT_ACTIVITY.blocked);
  });

  it("frees a blocked agent whose ticket the CEO gives to someone else", async () => {
    const office = openOffice(2);
    const ada = agentAt(office, 0);
    const bo = agentAt(office, 1);
    assign(office, "ticket-1", ada);
    await until(() => office.calls.length === 1);
    office.calls[0]?.finish(failure("no answer within 120s"));
    await until(() => ada.activity === AGENT_ACTIVITY.blocked);

    assign(office, "ticket-1", bo);
    await until(() => ada.activity === AGENT_ACTIVITY.idle && office.calls.length === 2);
    expect(ada.currentTicketId).toBe("");
    expect(office.calls[1]?.context.agentName).toBe(bo.name);
  });

  it("survives a cycle that throws, and blocks on the ticket rather than spinning", async () => {
    const office = openOffice();
    const ada = agentAt(office, 0);
    const brain = office.brains[0];
    assign(office, "ticket-1", ada);
    await until(() => office.calls.length === 1);

    // A broken executor: the contract says this never happens.
    office.calls[0]?.finish(undefined as unknown as WorkResult);
    await until(() => ada.activity === AGENT_ACTIVITY.blocked);
    expect(brain?.running).toBe(true);
    expect(office.ticket("ticket-1").comments.at(-1)?.authorId).toBe(ada.id);

    office.ceo({
      action: TICKET_ACTION.moveStatus,
      payload: { ticketId: "ticket-1", status: TICKET_STATUS.assigned },
    });
    await until(() => office.calls.length === 2);
    office.calls[1]?.finish(success("Fine this time."));
    await until(() => office.ticket("ticket-1").status === TICKET_STATUS.review);
  });
});

describe("teardown", () => {
  it("abandons a cycle in flight with no timer left and nothing written after", async () => {
    const office = openOffice(2);
    office.agents.forEach((agent, index) => assign(office, `ticket-${index + 1}`, agent));
    await until(() => office.calls.length === 2);

    const board = office.state.tickets.toJSON();
    const staff = office.state.occupants.toJSON();
    const linesBefore = logged.length;

    office.brains.forEach((brain) => brain.stop());
    office.closeTick();
    expect(office.calls.every((call) => call.signal?.aborted === true)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    // Work that resolves after the room has gone writes nothing.
    office.calls.forEach((call) => call.finish(success("Too late.")));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(office.state.tickets.toJSON()).toEqual(board);
    expect(office.state.occupants.toJSON()).toEqual(staff);
    expect(logged.length).toBe(linesBefore);
    expect(office.brains.every((brain) => !brain.running)).toBe(true);
  });

  it("tears down cleanly on the walk to the board too", async () => {
    const office = openOffice();
    const ada = agentAt(office, 0);
    assign(office, "ticket-1", ada);
    await until(() => office.calls.length === 1);
    office.calls[0]?.finish(success("On its way."));
    await until(() => ada.activity === AGENT_ACTIVITY.walking);

    office.brains[0]?.stop();
    office.closeTick();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(office.ticket("ticket-1").status).toBe(TICKET_STATUS.in_progress);
  });

  it("stops a brain whose agent has left the office", async () => {
    const office = openOffice();
    office.state.occupants.delete(agentAt(office, 0).id);
    await vi.advanceTimersByTimeAsync(2 * BRAIN_POLL_MS);
    expect(office.brains[0]?.running).toBe(false);
  });
});
