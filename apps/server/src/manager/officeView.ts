/**
 * What the AI manager can see: the office's live state, read into plain data.
 *
 * Both ways the manager answers — by rule (`./rulePlanner.ts`) and through a
 * model (`./modelPlanner.ts`) — read the same view, so a mock answer and a
 * model's answer are about the same office. It covers what the CEO asks about:
 * the orchestrator's live coding agents and their tasks, the runners' coding
 * agents on the floor that can be given an issue, each with what it is doing,
 * the issue it has and the pull request it opened, the standing tasks they
 * run between issues, and this repository's
 * issues and pull requests from the project board's feed, each issue with
 * whatever the office is doing about it, and the standup, on or the last one
 * held, with what each agent said at it.
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
  WORK_STATUS,
  WORK_STATUSES,
  type WorkStatus,
  actorOf,
  isCeo,
  isIssueAssignee,
  isLiveAgent,
  isSimulatedPullRequestArtifact,
  pullRequestOfArtifact,
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
 * the office's work rules; see `isIssueAssignee`. These are the runners'
 * coding agents: giving one an issue starts it, which spends real money.
 */
export interface IssueAgentView {
  /** Its occupant key, which is what its work names as the assignee. */
  readonly id: string;
  readonly name: string;
  /** Its title, the role the CEO gave it, `Software Developer` by default; `""` for none. */
  readonly title: string;
  readonly status: LiveAgentStatus;
  /** What it is doing right now, or what it waits on while it needs input; `""` when unknown. */
  readonly activity: string;
  /**
   * The issue it has in hand: the one it is working, else one handed to it
   * that it has not started, else one it handed in for review, whose pull
   * request it keeps until the CEO judges it. `undefined` when it has none.
   */
  readonly issue: WorkView | undefined;
  /**
   * The standing task it is running now, which it gives up the moment it is
   * handed an issue; `undefined` while it runs none.
   */
  readonly standing: { readonly taskName: string; readonly task: LinkView } | undefined;
  /** The recurring task it was hired for, by name, which it runs alone; `undefined` for an agent hired for no standing role. */
  readonly role: string | undefined;
}

/**
 * A standing task: a recurring job a coding agent does, such as watching for
 * new pull requests, as its runner last reported it.
 */
export interface StandingTaskView {
  /** Its id, which a plan may name it by. */
  readonly id: string;
  /** `pr-review`, `pr-steward` or `schedule`. */
  readonly kind: string;
  readonly name: string;
  /** `active`, `paused`, `waiting-slot`, `running`, `over-budget` or `error`. */
  readonly status: string;
  /** Its trigger in a few words: `every 2 min`, `weekdays 09:00`. */
  readonly trigger: string;
  /** Its newest run's outcome, such as `reviewed` or `simulated`; `undefined` before the first. */
  readonly lastOutcome: string | undefined;
  /** The pull request its newest run was about. */
  readonly lastRunPr: number | undefined;
  /** Events waiting for a free coding agent. */
  readonly queued: number;
  readonly spentTodayUsd: number;
  readonly dailyUsd: number;
  readonly lastError: string | undefined;
  /** The coding agent running it now, by name. */
  readonly runningOn: string | undefined;
  /** The coding agent hired for it, which runs it alone, by name; `undefined` for any free one. */
  readonly agent: string | undefined;
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
  /** The pull request its agent opened for it, when the deliverable is one. */
  readonly pullRequest: LinkView | undefined;
  /**
   * The deliverable is the mock agent's simulated pull request: nothing was
   * opened on GitHub, so there is no pull request to name or link.
   */
  readonly simulatedPullRequest: boolean;
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

/** One agent's update at the standup. */
export interface StandupUpdateView {
  readonly agent: string;
  readonly workedOn: string;
  /** `""` for none. */
  readonly blockers: string;
  /** It waited on a person when it spoke and has not carried on since. */
  readonly waitingOnYou: boolean;
  /** It waited on a person when it spoke and has carried on since. */
  readonly resolved: boolean;
}

/** The standup that is on, or the last one held. */
export interface StandupView {
  readonly active: boolean;
  /** `""` before the first standup. */
  readonly calledBy: string;
  /** The agents in the order they speak, by name, those still on the floor. */
  readonly order: readonly string[];
  readonly updates: readonly StandupUpdateView[];
}

/** A standup view of an office that has never held one. */
export const NO_STANDUP_VIEW: StandupView = { active: false, calledBy: "", order: [], updates: [] };

export interface OfficeView {
  /** The CEO's name, or `undefined` in the moment nobody holds the role. */
  readonly ceo: string | undefined;
  readonly liveAgents: readonly LiveAgentView[];
  readonly issueAgents: readonly IssueAgentView[];
  /**
   * How many coding agents the office may hire up to, and has now, on the
   * floor or on their way; absent with no runner connected, when it can hire none.
   */
  readonly hiring?: { readonly cap: number; readonly agents: number };
  /**
   * Every piece of work in the office, by status then issue number, including
   * finished work on an issue the board no longer lists.
   */
  readonly work: readonly WorkView[];
  /** `undefined` until the project board's first poll lands. */
  readonly project: ProjectView | undefined;
  /** Whether issues can be handed to live agents: an orchestrator is configured. */
  readonly orchestrator: boolean;
  /** The runners' standing tasks. */
  readonly standing: readonly StandingTaskView[];
  readonly standup: StandupView;
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
  const work: WorkView[] = [...state.work.values()].map((entry) => {
    const pull = pullRequestOfArtifact(entry.outputArtifact);
    return {
      issueNumber: entry.issueNumber,
      title: entry.title,
      status: entry.status,
      assigneeId: entry.assigneeId,
      assignee: state.occupants.get(entry.assigneeId)?.name,
      hasDeliverable: entry.outputArtifact !== "",
      pullRequest: pull === undefined ? undefined : link(pull.title, pull.url),
      simulatedPullRequest: isSimulatedPullRequestArtifact(entry.outputArtifact),
      note: entry.note === "" ? undefined : entry.note,
    };
  });
  work.sort(
    (a, b) =>
      WORK_STATUSES.indexOf(a.status) - WORK_STATUSES.indexOf(b.status) || a.issueNumber - b.issueNumber,
  );

  let ceo: string | undefined;
  const issueAgents: IssueAgentView[] = [];
  for (const occupant of state.occupants.values()) {
    if (isCeo(occupant)) {
      ceo = occupant.name;
    }
    if (isLiveAgent(occupant) && isIssueAssignee(actorOf(occupant))) {
      const running = [...state.standing.values()].find((task) => task.runningAgentId === occupant.id);
      const role = [...state.standing.values()].find((task) => task.agentId === occupant.id);
      issueAgents.push({
        id: occupant.id,
        name: occupant.name,
        title: occupant.title,
        status: occupant.status,
        activity: occupant.activity,
        issue: issueInHand(occupant.id, work),
        standing: running === undefined ? undefined : { taskName: running.name, task: link(occupant.taskTitle, occupant.taskUrl) },
        role: role?.name,
      });
    }
  }

  const standing: StandingTaskView[] = [...state.standing.values()].map((task) => ({
    id: task.id,
    kind: task.kind,
    name: task.name,
    status: task.status,
    trigger: task.trigger,
    lastOutcome: task.lastOutcome === "" ? undefined : task.lastOutcome,
    lastRunPr: task.lastRunPr === 0 ? undefined : task.lastRunPr,
    queued: task.queued,
    spentTodayUsd: task.spentTodayUsd,
    dailyUsd: task.dailyUsd,
    lastError: task.lastError === "" ? undefined : task.lastError,
    runningOn: task.runningAgentId === "" ? undefined : state.occupants.get(task.runningAgentId)?.name,
    agent: task.agentId === "" ? undefined : state.occupants.get(task.agentId)?.name,
  }));

  return {
    ceo,
    liveAgents: readLiveAgents(sources.liveAgents ?? []),
    issueAgents,
    work,
    project: sources.project === undefined ? undefined : readProject(sources.project, work),
    orchestrator: sources.liveAgents !== undefined,
    standing,
    standup: readStandup(state),
  };
}

function readStandup(state: OfficeState): StandupView {
  const { standup } = state;
  return {
    active: standup.active,
    calledBy: standup.calledBy,
    order: standup.order.toArray().flatMap((id) => {
      const name = state.occupants.get(id)?.name;
      return name === undefined ? [] : [name];
    }),
    updates: standup.updates.map((update) => ({
      agent: update.agentName,
      workedOn: update.workedOn,
      blockers: update.blockers,
      waitingOnYou: update.needsYou && !update.resolved,
      resolved: update.needsYou && update.resolved,
    })),
  };
}

/** The issue an agent is busiest with, by {@link IssueAgentView.issue}'s order. */
function issueInHand(agentId: string, work: readonly WorkView[]): WorkView | undefined {
  const mine = work.filter((entry) => entry.assigneeId === agentId);
  return (
    mine.find((entry) => entry.status === WORK_STATUS.in_progress) ??
    mine.find((entry) => entry.status === WORK_STATUS.assigned) ??
    mine.find((entry) => entry.status === WORK_STATUS.review)
  );
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
