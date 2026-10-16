/**
 * What the AI manager can see: the office's live state, read into plain data.
 *
 * Both ways the manager answers — by rule (`./rulePlanner.ts`) and through a
 * model (`./modelPlanner.ts`) — read the same view, so a mock answer and a
 * model's answer are about the same office. It covers what the CEO asks about:
 * the live coding agents and their tasks, the agents on the floor that can be
 * given an issue, and this repository's issues and
 * pull requests from the project board's feed, each issue with whatever the
 * office is doing about it.
 *
 * Built synchronously, in one pass over the room's state, between ticks. It
 * holds no schema objects: the model is handed it as JSON, and nothing the
 * manager does while it waits can be confused by work that moved under it.
 * Every string in it was sanitized by whoever wrote it into the office.
 */

import {
  type BoardIssue,
  type CheckStatus,
  type LiveAgentStatus,
  type OfficeState,
  type ProjectBoardSnapshot,
  WORK_STATUSES,
  type WorkStatus,
  actorOf,
  isCeo,
  isIssueAssignee,
  taskReference,
} from "@sim/shared";

import type { LiveAgentRecord } from "../agents/registry.js";

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
  /** What it is doing right now, or what it waits on while it needs input; `""` when unknown. */
  readonly activity: string;
  /** What the manager has handed it and it has not started yet. */
  readonly assigned: LinkView | undefined;
}

/**
 * A live agent on the floor that issue work can be given to directly, through
 * the office's work rules; see `isIssueAssignee`.
 */
export interface IssueAgentView {
  /** Its occupant key, which is what its work names as the assignee. */
  readonly id: string;
  readonly name: string;
}

/** What an agent is doing about one issue. */
export interface WorkView {
  readonly issueNumber: number;
  /** The issue's title, as of the last snapshot that listed it. */
  readonly title: string;
  readonly status: WorkStatus;
  readonly assigneeId: string;
  /** The assignee's name; `undefined` when they are no longer in the office. */
  readonly assignee: string | undefined;
  readonly hasDeliverable: boolean;
  /** The latest word on it, which is where "Blocked: …" lands; `undefined` when there is none. */
  readonly note: string | undefined;
}

export type IssueColumn = "open" | "in progress" | "closed";

export interface IssueView {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  /** The project board's column, which is GitHub's view: assigned there, or a linked PR. */
  readonly column: IssueColumn;
  readonly labels: readonly string[];
  /** GitHub logins it is assigned to on GitHub, which the office never changes. */
  readonly assignees: readonly string[];
  /** Open pull requests that say they close it. */
  readonly pullRequests: readonly number[];
  /** What an agent in the office is doing about it, if anyone is. */
  readonly work: WorkView | undefined;
}

export interface PullRequestView {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly labels: readonly string[];
  readonly author: string;
  readonly draft: boolean;
  readonly checks: CheckStatus;
}

export interface ProjectView {
  /** `owner/name`. */
  readonly repository: string;
  /** Whether the feed's last poll failed, so these lists may be out of date. */
  readonly stale: boolean;
  /** In progress, then open, then closed, each by number. */
  readonly issues: readonly IssueView[];
  readonly pullRequests: readonly PullRequestView[];
  /** GitHub's uncapped totals, which may be more than the lists carry. */
  readonly counts: ProjectBoardSnapshot["counts"];
}

export interface OfficeView {
  /** The CEO's name, or `undefined` in the moment nobody holds the role. */
  readonly ceo: string | undefined;
  readonly liveAgents: readonly LiveAgentView[];
  readonly issueAgents: readonly IssueAgentView[];
  /**
   * Every piece of work in the office, by status then issue number, including
   * finished work on an issue the board no longer lists.
   */
  readonly work: readonly WorkView[];
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

export function readLiveAgents(records: readonly LiveAgentRecord[]): LiveAgentView[] {
  return records.map((record) => ({
    id: record.id,
    name: record.name,
    status: record.status,
    task: record.task === undefined ? undefined : link(record.task.title, record.task.url),
    activity: record.activity ?? "",
    assigned: record.assignment === undefined ? undefined : link(record.assignment.title, record.assignment.url),
  }));
}

export function readOfficeView(sources: OfficeViewSources): OfficeView {
  const { state } = sources;
  let ceo: string | undefined;
  const issueAgents: IssueAgentView[] = [];
  for (const occupant of state.occupants.values()) {
    if (isCeo(occupant)) {
      ceo = occupant.name;
    }
    if (isIssueAssignee(actorOf(occupant))) {
      issueAgents.push({ id: occupant.id, name: occupant.name });
    }
  }

  const work: WorkView[] = [...state.work.values()].map((entry) => ({
    issueNumber: entry.issueNumber,
    title: entry.title,
    status: entry.status,
    assigneeId: entry.assigneeId,
    assignee: state.occupants.get(entry.assigneeId)?.name,
    hasDeliverable: entry.outputArtifact !== "",
    note: entry.note === "" ? undefined : entry.note,
  }));
  work.sort(
    (a, b) =>
      WORK_STATUSES.indexOf(a.status) - WORK_STATUSES.indexOf(b.status) || a.issueNumber - b.issueNumber,
  );

  return {
    ceo,
    liveAgents: readLiveAgents(sources.liveAgents ?? []),
    issueAgents,
    work,
    project: sources.project === undefined ? undefined : readProject(sources.project, work),
    orchestrator: sources.liveAgents !== undefined,
  };
}

function readProject(snapshot: ProjectBoardSnapshot, work: readonly WorkView[]): ProjectView {
  const base = `https://github.com/${snapshot.repository}`;
  const issues = (column: IssueColumn, list: readonly BoardIssue[]): IssueView[] =>
    list.map((issue) => ({
      number: issue.number,
      title: issue.title,
      url: `${base}/issues/${issue.number}`,
      column,
      labels: issue.labels.map((label) => label.name),
      assignees: issue.assignees,
      pullRequests: issue.pullRequests,
      work: work.find((entry) => entry.issueNumber === issue.number),
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
      labels: pull.labels.map((label) => label.name),
      author: pull.author,
      draft: pull.draft,
      checks: pull.checks,
    })),
    counts: snapshot.counts,
  };
}
