/**
 * What the AI manager can see: the office's live state, read into plain data.
 *
 * Both ways the manager answers — by rule (`./rulePlanner.ts`) and through a
 * model (`./modelPlanner.ts`) — read the same view, so a mock answer and a
 * model's answer are about the same office. It covers what the CEO asks about:
 * the agent employees and their tickets, the live coding agents and their
 * tasks, the ticket board, and this repository's issues and pull requests from
 * the project board's feed.
 *
 * Built synchronously, in one pass over the room's state, between ticks. It
 * holds no schema objects: the model is handed it as JSON, and nothing the
 * manager does while it waits can be confused by a ticket that moved under it.
 * Every string in it was sanitized by whoever wrote it into the office.
 */

import {
  type AgentActivity,
  type CheckStatus,
  type LiveAgentStatus,
  type OfficeState,
  type ProjectBoardSnapshot,
  SYSTEM_AUTHOR_ID,
  TICKET_STATUSES,
  type TicketPriority,
  type TicketStatus,
  isAgentEmployee,
  isCeo,
  taskReference,
} from "@sim/shared";

import type { LiveAgentRecord } from "../agents/registry.js";

/** An agent employee, simulated, working the in-game ticket board. */
export interface AgentView {
  readonly id: string;
  readonly name: string;
  readonly jobTitle: string;
  readonly activity: AgentActivity;
  /** The ticket it is holding, if any. */
  readonly ticketId: string | undefined;
}

/** A link with the short handle a person would say: `#33`, `PR #40`, or `""`. */
export interface LinkView {
  readonly title: string;
  readonly url: string;
  readonly reference: string;
}

/** A real coding agent, as its orchestrator last reported it. */
export interface LiveAgentView {
  /** The orchestrator's id for it, which is what an assignment names. */
  readonly id: string;
  readonly name: string;
  readonly status: LiveAgentStatus;
  readonly task: LinkView | undefined;
  /** What the manager has handed it and it has not started yet. */
  readonly assigned: LinkView | undefined;
}

export interface TicketView {
  readonly id: string;
  readonly title: string;
  readonly status: TicketStatus;
  readonly priority: TicketPriority;
  /** `""` when unassigned. */
  readonly assigneeId: string;
  /** The assignee's name; `undefined` when unassigned or no longer in the office. */
  readonly assignee: string | undefined;
  readonly hasDeliverable: boolean;
  /** The newest comment, by an agent or the system, which is where "Blocked: …" lands. */
  readonly latestNote: string | undefined;
}

export type IssueColumn = "open" | "in progress" | "closed";

export interface IssueView {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly column: IssueColumn;
  readonly labels: readonly string[];
  readonly assignees: readonly string[];
  /** Open pull requests that say they close it. */
  readonly pullRequests: readonly number[];
}

export interface PullRequestView {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: string;
  readonly draft: boolean;
  readonly checks: CheckStatus;
}

export interface ProjectView {
  /** `owner/name`. */
  readonly repository: string;
  /** Whether the feed's last poll failed, so these lists may be out of date. */
  readonly stale: boolean;
  readonly issues: readonly IssueView[];
  readonly pullRequests: readonly PullRequestView[];
}

export interface OfficeView {
  /** The CEO's name, or `undefined` in the moment nobody holds the role. */
  readonly ceo: string | undefined;
  readonly agents: readonly AgentView[];
  readonly liveAgents: readonly LiveAgentView[];
  /** In board order: by column, then by id. */
  readonly tickets: readonly TicketView[];
  /** `undefined` until the project board's first poll lands. */
  readonly project: ProjectView | undefined;
  /** Whether issues can be handed to live agents: an orchestrator is configured. */
  readonly orchestrator: boolean;
}

export interface OfficeViewSources {
  readonly state: OfficeState;
  readonly project: ProjectBoardSnapshot | undefined;
  /** `undefined` when no orchestrator is configured, which is not the same as none reporting. */
  readonly liveAgents: readonly LiveAgentRecord[] | undefined;
}

function link(title: string, url: string): LinkView {
  return { title, url, reference: taskReference(url) };
}

/** `ticket-12` sorts after `ticket-9`. */
function ticketNumber(id: string): number {
  const number = Number(/(\d+)$/.exec(id)?.[1] ?? Number.NaN);
  return Number.isFinite(number) ? number : Number.MAX_SAFE_INTEGER;
}

export function readOfficeView(sources: OfficeViewSources): OfficeView {
  const { state } = sources;
  const agents: AgentView[] = [];
  let ceo: string | undefined;
  for (const occupant of state.occupants.values()) {
    if (isCeo(occupant)) {
      ceo = occupant.name;
    }
    if (isAgentEmployee(occupant)) {
      agents.push({
        id: occupant.id,
        name: occupant.name,
        jobTitle: occupant.jobTitle,
        activity: occupant.activity,
        ticketId: occupant.currentTicketId === "" ? undefined : occupant.currentTicketId,
      });
    }
  }

  const tickets: TicketView[] = [...state.tickets.values()].map((ticket) => {
    const note = ticket.comments.at(-1);
    const assignee = ticket.assigneeId === "" ? undefined : state.occupants.get(ticket.assigneeId)?.name;
    return {
      id: ticket.id,
      title: ticket.title,
      status: ticket.status,
      priority: ticket.priority,
      assigneeId: ticket.assigneeId,
      assignee,
      hasDeliverable: ticket.outputArtifact !== "",
      latestNote:
        note === undefined
          ? undefined
          : `${note.authorId === SYSTEM_AUTHOR_ID ? "Office" : (state.occupants.get(note.authorId)?.name ?? "Someone")}: ${note.text}`,
    };
  });
  tickets.sort(
    (a, b) =>
      TICKET_STATUSES.indexOf(a.status) - TICKET_STATUSES.indexOf(b.status) ||
      ticketNumber(a.id) - ticketNumber(b.id),
  );

  const liveAgents = (sources.liveAgents ?? []).map(
    (record): LiveAgentView => ({
      id: record.id,
      name: record.name,
      status: record.status,
      task: record.task === undefined ? undefined : link(record.task.title, record.task.url),
      assigned: record.assignment === undefined ? undefined : link(record.assignment.title, record.assignment.url),
    }),
  );

  return {
    ceo,
    agents,
    liveAgents,
    tickets,
    project: sources.project === undefined ? undefined : readProject(sources.project),
    orchestrator: sources.liveAgents !== undefined,
  };
}

function readProject(snapshot: ProjectBoardSnapshot): ProjectView {
  const base = `https://github.com/${snapshot.repository}`;
  const issues = (column: IssueColumn, list: ProjectBoardSnapshot["open"]): IssueView[] =>
    list.map((issue) => ({
      number: issue.number,
      title: issue.title,
      url: `${base}/issues/${issue.number}`,
      column,
      labels: issue.labels.map((label) => label.name),
      assignees: issue.assignees,
      pullRequests: issue.pullRequests,
    }));
  return {
    repository: snapshot.repository,
    stale: snapshot.stale,
    issues: [
      ...issues("in progress", snapshot.inProgress),
      ...issues("open", snapshot.open),
      ...issues("closed", snapshot.closed),
    ],
    pullRequests: snapshot.pullRequests.map((pull) => ({
      number: pull.number,
      title: pull.title,
      url: `${base}/pull/${pull.number}`,
      author: pull.author,
      draft: pull.draft,
      checks: pull.checks,
    })),
  };
}
