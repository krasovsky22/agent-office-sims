/**
 * Carrying out the assignments in a manager's plan.
 *
 * A plan — from the rules or from a model — only names work and agents. Here
 * each name is resolved against the live office and the assignment is made, or
 * refused with the reason, and either way the manager says what happened.
 *
 * Two kinds of work go two ways:
 *
 * - **An in-game ticket** goes to an agent employee through
 *   `applyTicketCommand`, with the CEO who gave the instruction as the actor:
 *   the manager acts on the CEO's behalf and with exactly the CEO's authority,
 *   so the board's one gate decides, and an assignment the CEO could not make
 *   is not made. The agent's brain then claims it as it would any assignment.
 * - **A GitHub issue or pull request** goes to a live coding agent through the
 *   orchestrator's queue (`./liveAssignments.ts`); the manager decides and the
 *   orchestrator carries the work to the real agent.
 *
 * "Someone" — an empty agent — is whoever is least loaded and not stuck, among
 * the agents who can do that kind of work, counting what this same plan has
 * already handed out, so "hand out the backlog" spreads it.
 *
 * Synchronous: the manager calls this between ticks, once the model's answer
 * is in, against the board as it is at that moment.
 */

import {
  AGENT_ACTIVITY,
  type Occupant,
  TICKET_ACTION,
  TICKET_REJECTION,
  TICKET_STATUS,
  type TicketRejection,
  applyTicketCommand,
  sanitizeManagerText,
  ticketActorOf,
} from "@sim/shared";

import type { TicketHost } from "../rooms/ticketHandlers.js";
import type { PlannedAssignment } from "./advisor.js";
import type { LiveAssignmentQueue } from "./liveAssignments.js";
import type { AgentView, LiveAgentView, OfficeView } from "./officeView.js";
import { type GithubItem, type WorkRef, describeWork, resolveAgent, resolveWork } from "./resolve.js";

/** Most assignments one plan may make, so a runaway model cannot reassign the whole board. */
export const MAX_ASSIGNMENTS_PER_PLAN = 10;

export interface AssignContext {
  readonly tickets: TicketHost;
  /** The CEO the manager is acting for, as the room holds them now. */
  readonly ceo: Occupant;
  /** The office as it stands now, not as it stood when the question was asked. */
  readonly view: OfficeView;
  /** Absent when no orchestrator is configured. */
  readonly queue: LiveAssignmentQueue | undefined;
  /** Which room's manager is assigning, for the queue. */
  readonly origin: string;
  /** The CEO's words, passed to the orchestrator with an assignment. */
  readonly note: string;
}

const REFUSAL_TEXT: Readonly<Record<TicketRejection, string>> = {
  [TICKET_REJECTION.forbidden]: "only the CEO can assign tickets",
  [TICKET_REJECTION.unknownTicket]: "it is no longer on the board",
  [TICKET_REJECTION.illegalTransition]: "it is finished, and finished work keeps who did it",
  [TICKET_REJECTION.unknownAssignee]: "that agent is no longer in the office",
  [TICKET_REJECTION.missingAssignee]: "it needs an assignee",
  [TICKET_REJECTION.emptyEdit]: "that would change nothing",
  [TICKET_REJECTION.missingArtifact]: "it has no deliverable",
};

/**
 * Makes each assignment, in order.
 *
 * @returns one line per assignment saying what happened, for the reply.
 */
export function carryOut(assignments: readonly PlannedAssignment[], context: AssignContext): string[] {
  const load = new Map<string, number>();
  const lines: string[] = [];
  for (const assignment of assignments.slice(0, MAX_ASSIGNMENTS_PER_PLAN)) {
    lines.push(carryOutOne(assignment, context, load));
  }
  if (assignments.length > MAX_ASSIGNMENTS_PER_PLAN) {
    lines.push(`I stopped after ${MAX_ASSIGNMENTS_PER_PLAN} assignments; ask again for the rest.`);
  }
  return lines;
}

function carryOutOne(
  assignment: PlannedAssignment,
  context: AssignContext,
  load: Map<string, number>,
): string {
  const work = resolveWork(assignment.work, context.view);
  if (work === undefined) {
    return `✗ ${assignment.work}: I can't find that on the ticket board or the project board.`;
  }
  const label = describeWork(work);
  if (work.kind === "ticket") {
    return assignTicket(work, label, assignment.agent, context, load);
  }
  return assignGithub(work, label, assignment.agent, context, load);
}

function assignTicket(
  work: Extract<WorkRef, { kind: "ticket" }>,
  label: string,
  agentName: string,
  context: AssignContext,
  load: Map<string, number>,
): string {
  let agent: AgentView | undefined;
  if (agentName.trim() === "") {
    agent = freeAgent(context.view, load, work.ticket.assigneeId);
    if (agent === undefined) {
      return `✗ ${label}: there are no agent employees to give it to.`;
    }
  } else {
    const ref = resolveAgent(agentName, context.view);
    if (ref === undefined) {
      return `✗ ${label}: nobody called ${agentName} works here.`;
    }
    if (ref.kind === "live") {
      return `✗ ${label}: ${ref.agent.name} is a live coding agent, and in-game tickets go to the simulated staff.`;
    }
    agent = ref.agent;
  }
  if (work.ticket.assigneeId === agent.id) {
    return `• ${label} is already ${agent.name}'s.`;
  }

  const previous = work.ticket.assignee;
  const result = applyTicketCommand(
    { action: TICKET_ACTION.assign, payload: { ticketId: work.ticket.id, assigneeId: agent.id } },
    {
      board: context.tickets.state.tickets,
      occupants: context.tickets.state.occupants,
      actor: ticketActorOf(context.ceo),
      now: context.tickets.now(),
      nextTicketId: context.tickets.nextTicketId,
    },
  );
  if (!result.ok) {
    return `✗ ${label}: ${REFUSAL_TEXT[result.rejection]}.`;
  }
  load.set(agent.id, (load.get(agent.id) ?? 0) + 1);
  const from = previous === undefined || work.ticket.status === TICKET_STATUS.backlog ? "" : ` (from ${previous})`;
  return `✓ ${label} → ${agent.name}, ${agent.jobTitle}${from}.`;
}

function assignGithub(
  work: GithubItem,
  label: string,
  agentName: string,
  context: AssignContext,
  load: Map<string, number>,
): string {
  const queue = context.queue;
  if (queue === undefined) {
    return `✗ ${label}: no agent orchestrator is connected, so I can't hand GitHub work to live agents.`;
  }
  if (work.kind === "issue" && work.issue.column === "closed") {
    return `✗ ${label}: it is closed.`;
  }
  let agent: LiveAgentView | undefined;
  if (agentName.trim() === "") {
    agent = freeLiveAgent(context.view, load);
    if (agent === undefined) {
      return `✗ ${label}: every live agent is busy or already has something next; name one and I'll queue it anyway.`;
    }
  } else {
    const ref = resolveAgent(agentName, context.view);
    if (ref === undefined) {
      return `✗ ${label}: no live agent called ${agentName} is on the floor.`;
    }
    if (ref.kind === "agent") {
      return `✗ ${label}: ${ref.agent.name} is simulated staff; GitHub work goes to the live coding agents.`;
    }
    agent = ref.agent;
  }

  const item =
    work.kind === "issue"
      ? { kind: "issue" as const, number: work.issue.number, title: work.issue.title, url: work.issue.url }
      : { kind: "pull" as const, number: work.pull.number, title: work.pull.title, url: work.pull.url };
  if (agent.task?.url === item.url) {
    return `• ${label}: ${agent.name} is already working on it.`;
  }
  const queued = queue.assign({
    agentId: agent.id,
    item,
    requestedBy: context.ceo.name,
    note: sanitizeManagerText(context.note),
    origin: context.origin,
  });
  if (queued === undefined) {
    return `✗ ${label}: the orchestrator has not collected the last batch yet; try again shortly.`;
  }
  load.set(agent.id, (load.get(agent.id) ?? 0) + 1);
  return `✓ ${label} → ${agent.name}; queued for the orchestrator to hand over.`;
}

/**
 * The agent employee to give a ticket to when the CEO named nobody: not stuck,
 * then fewest tickets on their plate, then idle before busy, then roster order.
 * Never the ticket's current assignee, which would be no change.
 */
function freeAgent(view: OfficeView, load: ReadonlyMap<string, number>, currentId: string): AgentView | undefined {
  const plate = (agent: AgentView) =>
    view.tickets.filter(
      (ticket) =>
        ticket.assigneeId === agent.id &&
        (ticket.status === TICKET_STATUS.assigned || ticket.status === TICKET_STATUS.in_progress),
    ).length + (load.get(agent.id) ?? 0);
  const candidates = view.agents.filter((agent) => agent.id !== currentId);
  return [...candidates].sort(
    (a, b) =>
      Number(a.activity === AGENT_ACTIVITY.blocked) - Number(b.activity === AGENT_ACTIVITY.blocked) ||
      plate(a) - plate(b) ||
      Number(a.activity !== AGENT_ACTIVITY.idle) - Number(b.activity !== AGENT_ACTIVITY.idle) ||
      candidates.indexOf(a) - candidates.indexOf(b),
  )[0];
}

/** The live agent to hand GitHub work to when the CEO named nobody: idle, with nothing next. */
function freeLiveAgent(view: OfficeView, load: ReadonlyMap<string, number>): LiveAgentView | undefined {
  return view.liveAgents.find(
    (agent) => agent.status === "idle" && agent.assigned === undefined && (load.get(agent.id) ?? 0) === 0,
  );
}
