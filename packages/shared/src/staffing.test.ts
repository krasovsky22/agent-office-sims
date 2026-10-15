/**
 * Hiring, firing and quitting, against the real schema and the shipped floor
 * plan: who may do it, what it costs, where a hire is put, what a departure
 * does to the board, and that a refusal changes nothing.
 *
 * Written against the tunables rather than literal numbers, like the company
 * tests, so a rebalance does not have to be repeated here.
 */

import { describe, expect, it } from "vitest";

import {
  AGENT_NAMES,
  DEFAULT_AGENT_COUNT,
  HIRING_CANDIDATES,
  employAgent,
  freeAgentDesk,
  payrollOf,
  planAgentHires,
  planHire,
} from "./agents.js";
import {
  COMPANY_STATUS,
  MORALE_LOSS_PER_FIRING,
  QUIT_AFTER_LOW_MORALE_DAYS,
  STARTING_CASH,
  STARTING_MORALE,
  dailyPayroll,
} from "./company.js";
import { OFFICE_LAYOUT, interactables } from "./layout.js";
import { parseStaffFireMessage, parseStaffHireMessage } from "./messages.js";
import {
  QUIT_REASON,
  STAFF_ACTION,
  STAFF_REJECTION,
  type StaffCommand,
  type StaffCommandResult,
  applyStaffCommand,
  mayManageStaff,
  resolveQuitting,
} from "./staffing.js";
import {
  type AgentEmployee,
  HumanPlayer,
  OfficeState,
  PLAYER_ROLE,
  SYSTEM_AUTHOR_ID,
  TICKET_STATUS,
  isAgentEmployee,
} from "./state.js";
import { describeBoardProblems, seedBoard, ticketActorOf } from "./tickets.js";

const CEO_ID = "session-ceo";
const EXEC_ID = "session-exec";
const T0 = 1_700_000_000_000;

interface Office {
  readonly state: OfficeState;
  hiresSoFar: number;
}

/** A room as it opens: the starter board, the default agents, a CEO and an executive. */
function openOffice(agentCount = DEFAULT_AGENT_COUNT): Office {
  const state = new OfficeState();
  let next = 1;
  seedBoard(state.tickets, T0, () => `ticket-${next++}`);
  for (const hire of planAgentHires(OFFICE_LAYOUT, agentCount)) {
    state.occupants.set(hire.id, employAgent(hire));
  }
  for (const [id, role] of [
    [CEO_ID, PLAYER_ROLE.ceo],
    [EXEC_ID, PLAYER_ROLE.exec],
  ] as const) {
    const player = new HumanPlayer();
    player.id = id;
    player.name = id;
    player.role = role;
    state.occupants.set(id, player);
  }
  return { state, hiresSoFar: agentCount };
}

function run(office: Office, command: StaffCommand, actorId = CEO_ID): StaffCommandResult {
  const actor = office.state.occupants.get(actorId);
  if (actor === undefined) {
    throw new Error(`${actorId} is not in the office`);
  }
  const result = applyStaffCommand(command, {
    layout: OFFICE_LAYOUT,
    occupants: office.state.occupants,
    board: office.state.tickets,
    company: office.state.company,
    actor: ticketActorOf(actor),
    now: T0 + 1,
    hiresSoFar: office.hiresSoFar,
  });
  if (result.ok && result.action === STAFF_ACTION.hire) {
    office.hiresSoFar += 1;
  }
  return result;
}

function hire(candidateId: string): StaffCommand {
  return { action: STAFF_ACTION.hire, payload: { candidateId } };
}

function fire(agentId: string): StaffCommand {
  return { action: STAFF_ACTION.fire, payload: { agentId } };
}

function agents(office: Office): AgentEmployee[] {
  return [...office.state.occupants.values()].filter(isAgentEmployee);
}

function payroll(office: Office): number {
  return payrollOf(office.state.occupants.values());
}

const DESIGNER = HIRING_CANDIDATES[2];
if (DESIGNER === undefined) {
  throw new Error("the candidate list is empty");
}

describe("who may manage staff", () => {
  it("is the CEO alone", () => {
    const office = openOffice();
    const ceo = office.state.occupants.get(CEO_ID);
    const exec = office.state.occupants.get(EXEC_ID);
    expect(ceo !== undefined && mayManageStaff(ticketActorOf(ceo))).toBe(true);
    expect(exec !== undefined && mayManageStaff(ticketActorOf(exec))).toBe(false);
  });

  it("refuses an executive's hire and fire and changes nothing", () => {
    const office = openOffice();
    const before = office.state.toJSON();
    expect(run(office, hire(DESIGNER.id), EXEC_ID)).toEqual({
      ok: false,
      rejection: STAFF_REJECTION.forbidden,
    });
    expect(run(office, fire("agent-1"), EXEC_ID)).toEqual({
      ok: false,
      rejection: STAFF_REJECTION.forbidden,
    });
    expect(office.state.toJSON()).toEqual(before);
  });
});

describe("hiring", () => {
  it("puts a new agent at the next free agent desk, on the candidate's salary", () => {
    const office = openOffice();
    const result = run(office, hire(DESIGNER.id));
    expect(result.ok).toBe(true);
    if (!result.ok || result.action !== STAFF_ACTION.hire) {
      return;
    }
    const { agent } = result;
    expect(office.state.occupants.get(agent.id)).toBe(agent);
    expect(agent.jobTitle).toBe(DESIGNER.jobTitle);
    expect(agent.salary).toBe(DESIGNER.salary);
    expect(agent.deskId).toBe(OFFICE_LAYOUT.agentDesks[DEFAULT_AGENT_COUNT]);
    expect(agent.id).toBe(`agent-${DEFAULT_AGENT_COUNT + 1}`);
    expect(agent.name).toBe(AGENT_NAMES[DEFAULT_AGENT_COUNT]);
  });

  it("costs no cash now and adds the salary to the payroll", () => {
    const office = openOffice();
    const before = payroll(office);
    run(office, hire(DESIGNER.id));
    expect(office.state.company.cash).toBe(STARTING_CASH);
    expect(payroll(office)).toBe(before + DESIGNER.salary);
  });

  it("fills every agent desk and then refuses, without stacking anyone", () => {
    const office = openOffice();
    const free = OFFICE_LAYOUT.agentDesks.length - DEFAULT_AGENT_COUNT;
    for (let i = 0; i < free; i += 1) {
      expect(run(office, hire(DESIGNER.id)).ok).toBe(true);
    }
    const before = office.state.toJSON();
    expect(run(office, hire(DESIGNER.id))).toEqual({
      ok: false,
      rejection: STAFF_REJECTION.noFreeDesk,
    });
    expect(office.state.toJSON()).toEqual(before);
    const desks = agents(office).map((agent) => agent.deskId);
    expect(new Set(desks).size).toBe(OFFICE_LAYOUT.agentDesks.length);
  });

  it("skips a free desk somebody is sitting at, and says so when that is the only one", () => {
    const office = openOffice(OFFICE_LAYOUT.agentDesks.length - 1);
    const lastDesk = OFFICE_LAYOUT.agentDesks[OFFICE_LAYOUT.agentDesks.length - 1];
    const seat = interactables(OFFICE_LAYOUT).find((spec) => spec.deskId === lastDesk);
    const exec = office.state.occupants.get(EXEC_ID);
    if (seat === undefined || exec === undefined) {
      throw new Error("the last agent desk has no seat");
    }
    exec.interactableId = seat.id;
    expect(freeAgentDesk(OFFICE_LAYOUT, office.state.occupants.values())).toEqual({
      deskId: undefined,
      reason: "in-use",
    });
    expect(run(office, hire(DESIGNER.id))).toEqual({
      ok: false,
      rejection: STAFF_REJECTION.deskInUse,
    });

    exec.interactableId = "";
    expect(run(office, hire(DESIGNER.id)).ok).toBe(true);
  });

  it("refuses a job the office does not offer", () => {
    expect(run(openOffice(), hire("chief-vibes-officer"))).toEqual({
      ok: false,
      rejection: STAFF_REJECTION.unknownCandidate,
    });
  });

  it("refuses both commands once the company has folded", () => {
    const office = openOffice();
    office.state.company.status = COMPANY_STATUS.bankrupt;
    expect(run(office, hire(DESIGNER.id))).toEqual({
      ok: false,
      rejection: STAFF_REJECTION.notTrading,
    });
    expect(run(office, fire("agent-1"))).toEqual({
      ok: false,
      rejection: STAFF_REJECTION.notTrading,
    });
  });

  it("gives a rehire into a fired agent's desk a new id and a new name", () => {
    const office = openOffice();
    run(office, fire("agent-1"));
    const result = run(office, hire(DESIGNER.id));
    expect(result.ok && result.action === STAFF_ACTION.hire).toBe(true);
    if (!result.ok || result.action !== STAFF_ACTION.hire) {
      return;
    }
    expect(result.agent.deskId).toBe(OFFICE_LAYOUT.agentDesks[0]);
    expect(result.agent.id).not.toBe("agent-1");
    expect(result.agent.name).not.toBe(AGENT_NAMES[0]);
  });

  it("can drive the company to the end state by overhiring", () => {
    const office = openOffice();
    const { company } = office.state;
    while (run(office, hire(HIRING_CANDIDATES[HIRING_CANDIDATES.length - 1]?.id ?? "")).ok) {
      // Fill the floor with the best-paid job.
    }
    const overhired = payroll(office);
    const lean = dailyPayroll(
      planAgentHires(OFFICE_LAYOUT, DEFAULT_AGENT_COUNT).map((profile) => profile.salary),
    );
    expect(overhired).toBeGreaterThan(lean);
    // Fewer days of runway than the default office, counted the way midnight
    // draws it: whole payrolls until the cash is gone.
    expect(Math.ceil(company.cash / overhired)).toBeLessThan(Math.ceil(STARTING_CASH / lean));
  });
});

describe("firing", () => {
  it("removes the agent and costs the office morale", () => {
    const office = openOffice();
    const result = run(office, fire("agent-2"));
    expect(result).toMatchObject({ ok: true, action: STAFF_ACTION.fire, moraleLost: MORALE_LOSS_PER_FIRING });
    expect(office.state.occupants.has("agent-2")).toBe(false);
    expect(office.state.company.morale).toBe(STARTING_MORALE - MORALE_LOSS_PER_FIRING);
  });

  it("returns the agent's unfinished work to the backlog, with a note, whatever its column", () => {
    const office = openOffice();
    const statuses = [TICKET_STATUS.assigned, TICKET_STATUS.in_progress, TICKET_STATUS.review];
    const tickets = [...office.state.tickets.values()];
    statuses.forEach((status, index) => {
      const ticket = tickets[index];
      if (ticket !== undefined) {
        ticket.assigneeId = "agent-1";
        ticket.status = status;
      }
    });
    const finished = tickets[3];
    if (finished === undefined) {
      throw new Error("the starter board is too small");
    }
    finished.assigneeId = "agent-1";
    finished.status = TICKET_STATUS.done;

    const result = run(office, fire("agent-1"));
    expect(result.ok && result.action === STAFF_ACTION.fire).toBe(true);
    if (!result.ok || result.action !== STAFF_ACTION.fire) {
      return;
    }
    expect(result.departure.releasedTicketIds).toEqual(tickets.slice(0, 3).map((t) => t.id));
    for (const ticket of tickets.slice(0, 3)) {
      expect(ticket.status).toBe(TICKET_STATUS.backlog);
      expect(ticket.assigneeId).toBe("");
      const note = ticket.comments.at(-1);
      expect(note?.authorId).toBe(SYSTEM_AUTHOR_ID);
      expect(note?.text).toContain("Ada Byrne was let go");
    }
    // Finished work keeps the record of who did it.
    expect(finished.assigneeId).toBe("agent-1");
    expect(finished.status).toBe(TICKET_STATUS.done);
    expect(describeBoardProblems(office.state.tickets)).toEqual([]);
  });

  it("refuses to fire a player or someone not in the office", () => {
    const office = openOffice();
    for (const id of [EXEC_ID, "agent-99"]) {
      expect(run(office, fire(id))).toEqual({ ok: false, rejection: STAFF_REJECTION.unknownAgent });
    }
    expect(office.state.company.morale).toBe(STARTING_MORALE);
  });
});

describe("quitting", () => {
  function context(office: Office) {
    return {
      occupants: office.state.occupants,
      board: office.state.tickets,
      company: office.state.company,
      now: T0 + 1,
    };
  }

  it("does nothing until the low-morale streak is long enough", () => {
    const office = openOffice();
    office.state.company.lowMoraleDays = QUIT_AFTER_LOW_MORALE_DAYS - 1;
    expect(resolveQuitting(context(office))).toBeUndefined();
    expect(agents(office)).toHaveLength(DEFAULT_AGENT_COUNT);
  });

  it("loses the newest hire, hands their work back, and starts the streak again", () => {
    const office = openOffice();
    const ticket = office.state.tickets.get("ticket-1");
    if (ticket === undefined) {
      throw new Error("the starter board is empty");
    }
    const newest = `agent-${DEFAULT_AGENT_COUNT}`;
    ticket.assigneeId = newest;
    ticket.status = TICKET_STATUS.in_progress;
    office.state.company.lowMoraleDays = QUIT_AFTER_LOW_MORALE_DAYS;

    const departure = resolveQuitting(context(office));
    expect(departure?.agent.id).toBe(newest);
    expect(departure?.releasedTicketIds).toEqual(["ticket-1"]);
    expect(office.state.occupants.has(newest)).toBe(false);
    expect(ticket.status).toBe(TICKET_STATUS.backlog);
    expect(ticket.comments.at(-1)?.text).toContain(QUIT_REASON);
    expect(office.state.company.lowMoraleDays).toBe(0);
    // Quitting is its own cost; it does not also take the firing's morale.
    expect(office.state.company.morale).toBe(STARTING_MORALE);
  });

  it("resets the streak even when there is nobody left to quit", () => {
    const office = openOffice(0);
    office.state.company.lowMoraleDays = QUIT_AFTER_LOW_MORALE_DAYS;
    expect(resolveQuitting(context(office))).toBeUndefined();
    expect(office.state.company.lowMoraleDays).toBe(0);
  });
});

describe("planHire", () => {
  it("skips an id already on the floor", () => {
    const office = openOffice();
    const plan = planHire(
      OFFICE_LAYOUT,
      office.state.occupants.values(),
      DESIGNER,
      "desk-north-1",
      DEFAULT_AGENT_COUNT,
    );
    expect(plan.id).toBe(`agent-${DEFAULT_AGENT_COUNT + 1}`);
  });
});

describe("staff command parsers", () => {
  it("accepts an id and rejects anything else", () => {
    expect(parseStaffHireMessage({ candidateId: "qa-engineer" })).toEqual({
      candidateId: "qa-engineer",
    });
    expect(parseStaffFireMessage({ agentId: "agent-1" })).toEqual({ agentId: "agent-1" });
    for (const raw of [undefined, null, "agent-1", {}, { agentId: "" }, { agentId: 7 }]) {
      expect(parseStaffFireMessage(raw)).toBeUndefined();
    }
    expect(parseStaffHireMessage({ candidateId: "x".repeat(65) })).toBeUndefined();
  });
});
