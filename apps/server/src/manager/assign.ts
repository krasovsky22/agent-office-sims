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
 * - **To one of the runners' coding agents**, a GitHub issue goes through
 *   `applyWorkCommand`, with the CEO who gave the instruction as the actor:
 *   the manager acts on the CEO's behalf and with exactly the CEO's authority,
 *   so the work's one gate decides — the operator, the eligibility label —
 *   and an assignment the CEO could not make is not made. Once made, the
 *   runner starts the agent (`../agents/runnerWork.ts`).
 * - **To one of the orchestrator's live agents**, an issue or pull request
 *   goes through its queue (`./liveAssignments.ts`); the manager decides and
 *   the orchestrator carries the work to the real agent. Pull requests only go
 *   this way. A real agent runs code on a real machine, so where the office
 *   has an operator passphrase this takes a CEO who has proved it, by
 *   `mayCommandRealAgents`.
 *
 * Nothing is written to GitHub.
 *
 * A coding agent spends real money once it starts, so one is only ever put to
 * work when the CEO asked for it: by name, or as "a coding agent"
 * ({@link ANY_CODING_AGENT}), and the CEO's own words have to say so too, so a
 * model's plan cannot pick one the CEO never mentioned. "A coding agent" is
 * the first with no issue in hand, counting what this same plan has already
 * handed out, so "hand out the backlog to a coding agent" spreads it. A
 * runner's slot works one issue at a time, so a named coding agent with a
 * different issue in hand, or one from this same plan, is refused.
 * "Someone" — an empty agent — never means a coding agent: it is one of the
 * orchestrator's agents that is idle with nothing handed to it yet.
 *
 * Synchronous: the manager calls this between ticks, once the model's answer
 * is in, against the office as it is at that moment.
 */

import {
  type Occupant,
  WORK_ACTION,
  WORK_REJECTION,
  type WorkRejection,
  actorOf,
  mayCommandRealAgents,
  sanitizeManagerText,
} from "@sim/shared";

import { type WorkHost, applyAs } from "../rooms/workHandlers.js";
import { ANY_CODING_AGENT, type PlannedAssignment } from "./advisor.js";
import type { LiveAssignmentQueue } from "./liveAssignments.js";
import type { IssueAgentView, IssueView, LiveAgentView, OfficeView } from "./officeView.js";
import { type WorkRef, describeWork, findAgents, resolveAgent, resolveWork } from "./resolve.js";

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
  /**
   * The CEO's words: passed to the orchestrator with an assignment, and what
   * has to ask for a coding agent before one is put to work.
   */
  readonly note: string;
}

/** The CEO asking for one of the coding agents without naming it. */
const CODING_AGENT_WORDS = /\bcoding agents?\b/i;

/** Why a coding agent was not put to work: nobody asked for one. */
const ASK_FOR_ONE = "a coding agent spends real money, so I only put one to work when you name it or ask for “a coding agent”.";

const REFUSAL_TEXT: Readonly<Record<WorkRejection, string>> = {
  [WORK_REJECTION.forbidden]: "only the CEO can hand out work",
  [WORK_REJECTION.unknownIssue]: "it is not open on the project board",
  [WORK_REJECTION.noWork]: "nobody is working it",
  [WORK_REJECTION.illegalTransition]: "it is finished, and finished work keeps who did it",
  [WORK_REJECTION.unknownAssignee]: "that agent can no longer take issues",
  [WORK_REJECTION.missingArtifact]: "it has no deliverable",
  [WORK_REJECTION.notOperator]:
    "only a verified operator can send work to live coding agents; verify with the operator passphrase first",
  [WORK_REJECTION.notEligible]: "it does not carry the label that marks it ready for the coding agents",
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
  const anyCodingAgent = named.toLowerCase() === ANY_CODING_AGENT;
  const agent = named === "" || anyCodingAgent ? undefined : resolveAgent(named, context.view);
  if (named !== "" && !anyCodingAgent && agent === undefined) {
    return `✗ ${label}: nobody called ${named} works here.`;
  }
  const coder = context.view.issueAgents.find((candidate) => candidate === agent);
  if (coder !== undefined || anyCodingAgent) {
    if (work.kind === "pull") {
      return coder === undefined
        ? `✗ ${label}: pull requests go to the orchestrator's agents, and the coding agents are not among them.`
        : `✗ ${label}: pull requests go to the orchestrator's agents, and ${coder.name} is not one of them.`;
    }
    if (!askedFor(coder, context)) {
      return `✗ ${label}: ${ASK_FOR_ONE}`;
    }
    const assignee = coder ?? freeCodingAgent(work.issue, context.view, load);
    if (assignee === undefined) {
      return context.view.issueAgents.length === 0
        ? `✗ ${label}: there are no coding agents on the floor.`
        : `✗ ${label}: every coding agent already has an issue in hand.`;
    }
    return assignIssue(work.issue, label, assignee, context, load);
  }

  // Someone, or one of the orchestrator's agents by name: never a coding agent.
  const live = context.view.liveAgents.find((candidate) => candidate === agent);
  if (work.kind === "issue" && live === undefined && context.queue === undefined && context.view.issueAgents.length > 0) {
    return `✗ ${label}: ${ASK_FOR_ONE} Say “put a coding agent on #${work.issue.number}”.`;
  }
  return queueForLiveAgent(work, label, live, context, load);
}

/** Whether the CEO's words ask for this coding agent, or for any. */
function askedFor(coder: IssueAgentView | undefined, context: AssignContext): boolean {
  return (
    CODING_AGENT_WORDS.test(context.note) ||
    (coder !== undefined && findAgents(context.note, context.view).includes(coder))
  );
}

function assignIssue(
  issue: IssueView,
  label: string,
  agent: IssueAgentView,
  context: AssignContext,
  load: Map<string, number>,
): string {
  const current = issue.work;
  if (current?.assigneeId === agent.id) {
    return `• ${label} is already ${agent.name}'s.`;
  }
  if (agent.issue !== undefined || (load.get(agent.id) ?? 0) > 0) {
    const held = agent.issue === undefined ? "" : ` (#${agent.issue.issueNumber})`;
    return `✗ ${label}: ${agent.name} already has an issue in hand${held}; a coding agent works one at a time.`;
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
  return `✓ ${label} → ${agent.name}${from}.`;
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
 * The coding agent to give an issue to when the CEO asked for "a coding
 * agent": the one that already has it, which is no change, else the first in
 * roster order with no issue in hand and none from this plan. A runner's slot
 * holds one issue at a time, review included, so there may be none.
 */
function freeCodingAgent(issue: IssueView, view: OfficeView, load: ReadonlyMap<string, number>): IssueAgentView | undefined {
  return (
    view.issueAgents.find((agent) => agent.id === issue.work?.assigneeId) ??
    view.issueAgents.find((agent) => agent.issue === undefined && (load.get(agent.id) ?? 0) === 0)
  );
}

/** The live agent to hand GitHub work to when the CEO named nobody: idle, with nothing next. */
function freeLiveAgent(view: OfficeView, load: ReadonlyMap<string, number>): LiveAgentView | undefined {
  return view.liveAgents.find(
    (agent) => agent.status === "idle" && agent.assigned === undefined && (load.get(agent.id) ?? 0) === 0,
  );
}
