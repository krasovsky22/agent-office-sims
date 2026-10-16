/**
 * Carrying out the assignments in a manager's plan.
 *
 * A plan — from the rules or from a model — only names work and agents. Here
 * each name is resolved against the live office and the assignment is made, or
 * refused with the reason, and either way the manager says what happened.
 *
 * All of the work is the project board's, and it goes two ways depending on
 * who is to do it:
 *
 * - **To an agent employee**, a GitHub issue goes through `applyWorkCommand`,
 *   with the CEO who gave the instruction as the actor: the manager acts on
 *   the CEO's behalf and with exactly the CEO's authority, so the work's one
 *   gate decides, and an assignment the CEO could not make is not made. The
 *   agent's brain then claims it as it would any assignment. Nothing is
 *   written to GitHub.
 * - **To a live coding agent**, an issue or pull request goes through the
 *   orchestrator's queue (`./liveAssignments.ts`); the manager decides and the
 *   orchestrator carries the work to the real agent. Pull requests only go
 *   this way: the agent employees work issues. A real agent runs code on a
 *   real machine, so where the office has an operator passphrase this takes
 *   a CEO who has proved it, by `mayCommandRealAgents`.
 *
 * "Someone" — an empty agent — is whoever is least loaded and not stuck, among
 * the agents who can do that kind of work, counting what this same plan has
 * already handed out, so "hand out the backlog" spreads it. For an issue that
 * is the agent employees, and the live agents only in an office that has no
 * employees at all.
 *
 * Synchronous: the manager calls this between ticks, once the model's answer
 * is in, against the office as it is at that moment.
 */

import {
  AGENT_ACTIVITY,
  type Occupant,
  WORK_ACTION,
  WORK_REJECTION,
  WORK_STATUS,
  type WorkRejection,
  actorOf,
  mayCommandRealAgents,
  sanitizeManagerText,
} from "@sim/shared";

import { type WorkHost, applyAs } from "../rooms/workHandlers.js";
import type { PlannedAssignment } from "./advisor.js";
import type { LiveAssignmentQueue } from "./liveAssignments.js";
import type { AgentView, IssueView, LiveAgentView, OfficeView } from "./officeView.js";
import { type WorkRef, describeWork, resolveAgent, resolveWork } from "./resolve.js";

/** Most assignments one plan may make, so a runaway model cannot reassign the whole board. */
export const MAX_ASSIGNMENTS_PER_PLAN = 10;

export interface AssignContext {
  readonly work: WorkHost;
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

const REFUSAL_TEXT: Readonly<Record<WorkRejection, string>> = {
  [WORK_REJECTION.forbidden]: "only the CEO can hand out work",
  [WORK_REJECTION.unknownIssue]: "it is not open on the project board",
  [WORK_REJECTION.noWork]: "nobody is working it",
  [WORK_REJECTION.illegalTransition]: "it is finished, and finished work keeps who did it",
  [WORK_REJECTION.unknownAssignee]: "that agent is no longer in the office",
  [WORK_REJECTION.missingArtifact]: "it has no deliverable",
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
    return `✗ ${assignment.work}: I can't find that on the project board.`;
  }
  const label = describeWork(work);
  if (work.kind === "issue" && work.issue.column === "closed") {
    return `✗ ${label}: it is closed.`;
  }

  const named = assignment.agent.trim();
  if (named === "") {
    if (work.kind === "issue" && (context.view.agents.length > 0 || context.queue === undefined)) {
      const agent = freeAgent(context.view, load, work.issue.work?.assigneeId ?? "");
      return agent === undefined
        ? `✗ ${label}: there are no agent employees to give it to.`
        : assignIssue(work.issue, label, agent, context, load);
    }
    return queueForLiveAgent(work, label, undefined, context, load);
  }

  const ref = resolveAgent(named, context.view);
  if (ref === undefined) {
    return `✗ ${label}: nobody called ${named} works here.`;
  }
  if (ref.kind === "live") {
    return queueForLiveAgent(work, label, ref.agent, context, load);
  }
  if (work.kind === "pull") {
    return `✗ ${label}: ${ref.agent.name} is simulated staff and works issues; pull requests go to the live coding agents.`;
  }
  return assignIssue(work.issue, label, ref.agent, context, load);
}

function assignIssue(
  issue: IssueView,
  label: string,
  agent: AgentView,
  context: AssignContext,
  load: Map<string, number>,
): string {
  const current = issue.work;
  if (current?.assigneeId === agent.id) {
    return `• ${label} is already ${agent.name}'s.`;
  }
  const result = applyAs(context.work, actorOf(context.ceo), {
    action: WORK_ACTION.assign,
    payload: { issueNumber: issue.number, assigneeId: agent.id },
  });
  if (!result.ok) {
    return `✗ ${label}: ${REFUSAL_TEXT[result.rejection]}.`;
  }
  load.set(agent.id, (load.get(agent.id) ?? 0) + 1);
  const from = current?.assignee === undefined ? "" : ` (from ${current.assignee})`;
  return `✓ ${label} → ${agent.name}, ${agent.jobTitle}${from}.`;
}

function queueForLiveAgent(
  work: WorkRef,
  label: string,
  named: LiveAgentView | undefined,
  context: AssignContext,
  load: Map<string, number>,
): string {
  const queue = context.queue;
  if (queue === undefined) {
    return work.kind === "pull"
      ? `✗ ${label}: pull requests go to live coding agents, and no agent orchestrator is connected.`
      : `✗ ${label}: no agent orchestrator is connected, so I can't hand GitHub work to live agents.`;
  }
  if (context.work.state.operatorRequired && !mayCommandRealAgents(actorOf(context.ceo))) {
    return `✗ ${label}: only a verified operator can send work to live coding agents; verify with the operator passphrase first.`;
  }
  const agent = named ?? freeLiveAgent(context.view, load);
  if (agent === undefined) {
    return `✗ ${label}: every live agent is busy or already has something next; name one and I'll queue it anyway.`;
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
 * The agent employee to give an issue to when the CEO named nobody: not stuck,
 * then fewest issues on their plate, then idle before busy, then roster order.
 * Never the issue's current assignee, which would be no change.
 */
function freeAgent(view: OfficeView, load: ReadonlyMap<string, number>, currentId: string): AgentView | undefined {
  const plate = (agent: AgentView) =>
    view.work.filter(
      (work) =>
        work.assigneeId === agent.id &&
        (work.status === WORK_STATUS.assigned || work.status === WORK_STATUS.in_progress),
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
