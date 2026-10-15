/**
 * The rules of hiring and firing, and of an agent walking out.
 *
 * `agents.ts` says who the office could hire and where they would sit; this
 * module says when the CEO may, what it costs, and what an agent leaving does
 * to the board. It is the staffing counterpart of `tickets.ts`, in the same
 * shape: one authority gate the client also asks, and one applier that
 * validates a parsed command against the live room and mutates it, or rejects
 * it and changes nothing.
 *
 * An agent leaving — fired, or quitting — goes through {@link removeAgent}
 * either way, so the two departures treat the board identically: every ticket
 * the agent still had open is returned to the backlog with a note saying why,
 * so the work is waiting for the CEO to hand on rather than pointing at
 * somebody who is no longer there.
 *
 * Everything is synchronous and allocation-light: the room calls the applier
 * from a message handler and {@link resolveQuitting} from the simulation tick,
 * and neither may make the tick wait.
 */

import { type MapSchema } from "@colyseus/schema";

import {
  type HiringCandidate,
  employAgent,
  freeAgentDesk,
  hiringCandidateById,
  planHire,
} from "./agents.js";
import {
  QUIT_AFTER_LOW_MORALE_DAYS,
  QUIT_MORALE_THRESHOLD,
  applyFiringMorale,
  isDueToQuit,
  isTrading,
} from "./company.js";
import { MAX_TICKET_COMMENTS } from "./constants.js";
import type { OfficeLayout } from "./layout.js";
import type { StaffFireMessage, StaffHireMessage } from "./messages.js";
import {
  type AgentEmployee,
  type Company,
  type Occupant,
  SYSTEM_AUTHOR_ID,
  TICKET_STATUS,
  type Ticket,
  TicketComment,
  isAgentEmployee,
} from "./state.js";
import type { TicketActor } from "./tickets.js";

/** What a staffing command wants to do. */
export const STAFF_ACTION = {
  hire: "hire",
  fire: "fire",
} as const;

export type StaffAction = (typeof STAFF_ACTION)[keyof typeof STAFF_ACTION];

/**
 * Whether an actor may hire or fire. **The one staffing authority gate.**
 *
 * Both are the CEO's, for the same reason every board write but a comment is:
 * spending the company's cash and deciding who works there are the decisions
 * the role exists to make. The client asks this too, to decide whether to
 * offer the controls at all.
 */
export function mayManageStaff(actor: TicketActor): boolean {
  return actor.isCeo;
}

/** Why a staffing command was refused. Rejection never changes the room. */
export const STAFF_REJECTION = {
  /** The authority gate said no. */
  forbidden: "forbidden",
  /** The company has folded, and a folded company neither hires nor fires. */
  notTrading: "not-trading",
  /** The hire named a job the office does not offer. */
  unknownCandidate: "unknown-candidate",
  /** Every agent desk in the floor plan already has an agent. */
  noFreeDesk: "no-free-desk",
  /** The only desks without an agent have somebody sitting at them. */
  deskInUse: "desk-in-use",
  /** The fire named someone who is not an agent employee in the office. */
  unknownAgent: "unknown-agent",
} as const;

export type StaffRejection = (typeof STAFF_REJECTION)[keyof typeof STAFF_REJECTION];

/** A parsed command, tagged so the applier can switch on it. */
export type StaffCommand =
  | { readonly action: typeof STAFF_ACTION.hire; readonly payload: StaffHireMessage }
  | { readonly action: typeof STAFF_ACTION.fire; readonly payload: StaffFireMessage };

/** Everything a command needs that is not in its own payload. */
export interface StaffCommandContext {
  readonly layout: OfficeLayout;
  readonly occupants: MapSchema<Occupant>;
  readonly board: MapSchema<Ticket>;
  readonly company: Company;
  readonly actor: TicketActor;
  /** Epoch milliseconds to stamp on any ticket the command changes. */
  readonly now: number;
  /**
   * How many agents the room has hired so far, the ones it opened with
   * included. A hire is numbered one past it; see {@link planHire}.
   */
  readonly hiresSoFar: number;
}

/** What an agent leaving did, for the announcement. */
export interface Departure {
  readonly agent: AgentEmployee;
  /** Ids of the tickets returned to the backlog, in board order. */
  readonly releasedTicketIds: readonly string[];
}

export type StaffCommandResult =
  | {
      readonly ok: true;
      readonly action: typeof STAFF_ACTION.hire;
      readonly agent: AgentEmployee;
    }
  | {
      readonly ok: true;
      readonly action: typeof STAFF_ACTION.fire;
      readonly departure: Departure;
      /** How far company morale fell, which may be less than the tunable at the floor. */
      readonly moraleLost: number;
    }
  | { readonly ok: false; readonly rejection: StaffRejection };

function reject(rejection: StaffRejection): StaffCommandResult {
  return { ok: false, rejection };
}

/**
 * Validates a staffing command against the live room and applies it, or
 * rejects it.
 *
 * Authority first, then whether the company is trading, then the command's own
 * checks; nothing is written until all of them pass.
 */
export function applyStaffCommand(
  command: StaffCommand,
  context: StaffCommandContext,
): StaffCommandResult {
  if (!mayManageStaff(context.actor)) {
    return reject(STAFF_REJECTION.forbidden);
  }
  if (!isTrading(context.company)) {
    return reject(STAFF_REJECTION.notTrading);
  }
  switch (command.action) {
    case STAFF_ACTION.hire:
      return hire(command.payload, context);
    case STAFF_ACTION.fire:
      return fire(command.payload, context);
  }
}

/**
 * Puts a new agent at the first free agent desk.
 *
 * The hire costs nothing on the spot: the salary is first drawn at the next
 * midnight, which reads it off the agent now on the floor.
 */
function hire(payload: StaffHireMessage, context: StaffCommandContext): StaffCommandResult {
  const candidate: HiringCandidate | undefined = hiringCandidateById(payload.candidateId);
  if (candidate === undefined) {
    return reject(STAFF_REJECTION.unknownCandidate);
  }
  const desk = freeAgentDesk(context.layout, context.occupants.values());
  if (desk.deskId === undefined) {
    return reject(desk.reason === "full" ? STAFF_REJECTION.noFreeDesk : STAFF_REJECTION.deskInUse);
  }

  const agent = employAgent(
    planHire(
      context.layout,
      context.occupants.values(),
      candidate,
      desk.deskId,
      context.hiresSoFar + 1,
    ),
  );
  context.occupants.set(agent.id, agent);
  return { ok: true, action: STAFF_ACTION.hire, agent };
}

/** Lets an agent go: their work goes back on the board, and morale takes the hit. */
function fire(payload: StaffFireMessage, context: StaffCommandContext): StaffCommandResult {
  const agent = context.occupants.get(payload.agentId);
  if (agent === undefined || !isAgentEmployee(agent)) {
    return reject(STAFF_REJECTION.unknownAgent);
  }
  const departure = removeAgent(agent, context, `${agent.name} was let go`);
  const moraleLost = applyFiringMorale(context.company);
  return { ok: true, action: STAFF_ACTION.fire, departure, moraleLost };
}

/**
 * Takes an agent off the floor and hands their unfinished work back.
 *
 * Every ticket the agent is assigned that is not `done` goes to `backlog` with
 * no assignee, whatever column it was in, and gets a system comment saying why
 * — so it is never left pointing at someone who has gone, and the reason is on
 * the card for whoever picks it up. Its deliverable, if it has one, stays on
 * it. This deliberately steps outside the transition table, which only walks
 * `in_progress` back a column at a time: that rule is for a player's command,
 * and the person whose work it was is no longer there to walk it.
 *
 * A `done` ticket keeps the agent as its assignee, which is the record of who
 * finished it.
 */
export function removeAgent(
  agent: AgentEmployee,
  context: Pick<StaffCommandContext, "occupants" | "board" | "now">,
  reason: string,
): Departure {
  const releasedTicketIds: string[] = [];
  for (const ticket of context.board.values()) {
    if (ticket.assigneeId !== agent.id || ticket.status === TICKET_STATUS.done) {
      continue;
    }
    ticket.status = TICKET_STATUS.backlog;
    ticket.assigneeId = "";
    ticket.updatedAt = context.now;
    noteOnTicket(ticket, `Returned to the backlog: ${reason}.`, context.now);
    releasedTicketIds.push(ticket.id);
  }
  context.occupants.delete(agent.id);
  return { agent, releasedTicketIds };
}

function noteOnTicket(ticket: Ticket, text: string, now: number): void {
  const comment = new TicketComment();
  comment.authorId = SYSTEM_AUTHOR_ID;
  comment.text = text;
  comment.createdAt = now;
  while (ticket.comments.length >= MAX_TICKET_COMMENTS) {
    ticket.comments.shift();
  }
  ticket.comments.push(comment);
}

/** The reason an agent who quit gives, for the ticket note and the announcement. */
export const QUIT_REASON = `morale stayed under ${QUIT_MORALE_THRESHOLD}% for ${QUIT_AFTER_LOW_MORALE_DAYS} days`;

/**
 * Lets a run of low-morale days claim an agent, if it has run long enough.
 *
 * Called by the room straight after a day closes. The agent who goes is the
 * most recently hired — last in, first out, the one with the least reason to
 * stay — and the streak starts again, so the next departure needs another run
 * of bad days rather than following at the next midnight.
 *
 * @returns the departure, or `undefined` if nobody quit.
 */
export function resolveQuitting(
  context: Pick<StaffCommandContext, "occupants" | "board" | "company" | "now">,
): Departure | undefined {
  if (!isDueToQuit(context.company)) {
    return undefined;
  }
  let leaving: AgentEmployee | undefined;
  for (const occupant of context.occupants.values()) {
    if (isAgentEmployee(occupant)) {
      leaving = occupant;
    }
  }
  context.company.lowMoraleDays = 0;
  return leaving === undefined
    ? undefined
    : removeAgent(leaving, context, `${leaving.name} quit because ${QUIT_REASON}`);
}
