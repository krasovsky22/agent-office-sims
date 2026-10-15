/**
 * What the AI manager says without being asked: work handed in, an agent stuck,
 * a live agent starting or stopping, an assignment picked up by the orchestrator.
 *
 * The manager looks at the office on its own timer and compares what it sees
 * with what it saw last time; this module is that comparison, as two pure
 * functions, so what counts as news can be tested without a room. The first
 * look only sets the baseline: a manager arriving in an office does not
 * announce everything already in it.
 *
 * Templated, never a model call: an update is a fact the state already holds,
 * and it costs nothing to say.
 */

import { AGENT_ACTIVITY, type AgentActivity, TICKET_STATUS, type TicketStatus } from "@sim/shared";

import { LIVE_ASSIGNMENT_STATUS, type LiveAssignment, type LiveAssignmentStatus } from "./liveAssignments.js";
import type { LinkView, OfficeView } from "./officeView.js";

/** What the manager remembers between looks. */
export interface Observation {
  readonly agents: ReadonlyMap<string, { readonly name: string; readonly activity: AgentActivity; readonly ticketId: string | undefined }>;
  readonly tickets: ReadonlyMap<
    string,
    {
      readonly label: string;
      readonly status: TicketStatus;
      readonly assignee: string | undefined;
      readonly latestNote: string | undefined;
    }
  >;
  readonly liveAgents: ReadonlyMap<
    string,
    { readonly name: string; readonly working: boolean; readonly task: LinkView | undefined }
  >;
  readonly assignments: ReadonlyMap<string, { readonly status: LiveAssignmentStatus; readonly label: string; readonly agent: string }>;
}

function linkText(link: LinkView | undefined): string {
  if (link === undefined) {
    return "its task";
  }
  return link.reference === "" ? `“${link.title}”` : `${link.reference} “${link.title}”`;
}

/** Takes one look. */
export function observe(view: OfficeView, assignments: readonly LiveAssignment[]): Observation {
  const liveNames = new Map(view.liveAgents.map((agent) => [agent.id, agent.name]));
  return {
    agents: new Map(
      view.agents.map((agent) => [agent.id, { name: agent.name, activity: agent.activity, ticketId: agent.ticketId }]),
    ),
    tickets: new Map(
      view.tickets.map((ticket) => [
        ticket.id,
        {
          label: `${ticket.id} “${ticket.title}”`,
          status: ticket.status,
          assignee: ticket.assignee,
          latestNote: ticket.latestNote,
        },
      ]),
    ),
    liveAgents: new Map(
      view.liveAgents.map((agent) => [agent.id, { name: agent.name, working: agent.status === "working", task: agent.task }]),
    ),
    assignments: new Map(
      assignments.map((assignment) => [
        assignment.id,
        {
          status: assignment.status,
          label: `${assignment.item.kind === "pull" ? "PR " : ""}#${assignment.item.number} “${assignment.item.title}”`,
          agent: liveNames.get(assignment.agentId) ?? assignment.agentId,
        },
      ]),
    ),
  };
}

/** Every piece of news between two looks, in a stable order. */
export function describeChanges(before: Observation, after: Observation): string[] {
  const lines: string[] = [];

  for (const [id, ticket] of after.tickets) {
    const previous = before.tickets.get(id);
    if (previous?.status === TICKET_STATUS.in_progress && ticket.status === TICKET_STATUS.review) {
      lines.push(`${ticket.assignee ?? "Its assignee"} handed in ${ticket.label} for your review.`);
    }
  }

  for (const [id, agent] of after.agents) {
    const previous = before.agents.get(id);
    if (previous !== undefined && previous.activity !== AGENT_ACTIVITY.blocked && agent.activity === AGENT_ACTIVITY.blocked) {
      const ticket = agent.ticketId === undefined ? undefined : after.tickets.get(agent.ticketId);
      lines.push(
        ticket === undefined
          ? `${agent.name} is stuck.`
          : `${agent.name} is stuck on ${ticket.label} — ${ticket.latestNote ?? "no reason given"}`,
      );
    }
  }

  for (const [id, agent] of after.liveAgents) {
    const previous = before.liveAgents.get(id);
    if (previous === undefined) {
      lines.push(`${agent.name} came in${agent.working ? `, working on ${linkText(agent.task)}` : ""}.`);
    } else if (agent.working && (!previous.working || previous.task?.url !== agent.task?.url)) {
      lines.push(`${agent.name} started on ${linkText(agent.task)}.`);
    } else if (previous.working && !agent.working) {
      lines.push(`${agent.name} stopped working on ${linkText(previous.task)} and is free.`);
    }
  }
  for (const [id, agent] of before.liveAgents) {
    if (!after.liveAgents.has(id)) {
      lines.push(`${agent.name} left the office.`);
    }
  }

  for (const [id, assignment] of after.assignments) {
    // One made and collected between two looks was pending all the same.
    const previous = before.assignments.get(id);
    const wasPending = previous === undefined || previous.status === LIVE_ASSIGNMENT_STATUS.pending;
    if (wasPending && assignment.status !== LIVE_ASSIGNMENT_STATUS.pending) {
      lines.push(`The orchestrator picked up ${assignment.label} for ${assignment.agent}.`);
    }
  }
  return lines;
}
