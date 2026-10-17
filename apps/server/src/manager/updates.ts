/**
 * What the AI manager says without being asked: a coding agent starting on
 * its issue, opening its pull request, or failing; a live agent starting,
 * stopping or waiting on a person; an assignment picked up by the orchestrator
 * or not taken by its agent.
 *
 * A coding agent's news is read off its work, which the runner's events move
 * (`../agents/runnerWork.ts`): `started` claims it, `pr-opened` hands it in
 * with the pull request as its deliverable, and `failed` writes the runner's
 * reason as the agent's note. Every refusal the runner makes after the
 * assignment — the eligibility label re-checked on GitHub, a slot already
 * busy, a spent budget — arrives as such a reason and is passed on as
 * written; the refusals the office makes itself, the operator's and the
 * label's, are in the reply to the assignment instead (`./assign.ts`).
 *
 * The manager looks at the office on its own timer and compares what it sees
 * with what it saw last time; this module is that comparison, as two pure
 * functions, so what counts as news can be tested without a room. The first
 * look sets the baseline for everything but an agent already waiting on a
 * person: a manager arriving in an office does not announce everything already
 * in it, yet someone stuck until a person acts is still posted, once.
 *
 * Templated, never a model call: an update is a fact the state already holds,
 * and it costs nothing to say.
 */

import { LIVE_AGENT_STATUS, WORK_STATUS, type WorkStatus, isLiveAgentOnTask } from "@sim/shared";

import { LIVE_ASSIGNMENT_STATUS, type LiveAssignment, type LiveAssignmentStatus } from "./liveAssignments.js";
import type { LinkView, LiveAgentView, OfficeView } from "./officeView.js";

/** What the manager remembers between looks. */
export interface Observation {
  readonly work: ReadonlyMap<
    number,
    {
      readonly label: string;
      readonly status: WorkStatus;
      readonly assigneeId: string;
      readonly assignee: string | undefined;
      readonly pullRequest: LinkView | undefined;
      readonly note: string | undefined;
    }
  >;
  readonly liveAgents: ReadonlyMap<
    string,
    {
      readonly name: string;
      /** On a task, whether at it or waiting on a person. */
      readonly working: boolean;
      readonly task: LinkView | undefined;
    }
  >;
  /** Every agent on the floor waiting on a person, the runners' slots too. */
  readonly waiting: ReadonlyMap<
    string,
    { readonly name: string; readonly activity: string; readonly task: LinkView | undefined }
  >;
  readonly assignments: ReadonlyMap<string, { readonly status: LiveAssignmentStatus; readonly label: string; readonly agent: string }>;
}

function linkText(link: LinkView | undefined): string {
  if (link === undefined) {
    return "its task";
  }
  return link.reference === "" ? `“${link.title}”` : `${link.reference} “${link.title}”`;
}

/** `Claude 1 needs you on #39: Permission: Bash`, naming the task as briefly as it can. */
function needsYouText(name: string, task: LinkView | undefined, reason: string): string {
  const on = task === undefined ? "" : ` on ${task.reference === "" ? `“${task.title}”` : task.reference}`;
  return `${name} needs you${on}${reason === "" ? "." : `: ${reason}`}`;
}

/**
 * Takes one look. `floor` is every live agent on the floor, which the manager
 * watches only for one waiting on a person; the rest of its news is about
 * `view`'s.
 */
export function observe(
  view: OfficeView,
  assignments: readonly LiveAssignment[],
  floor: readonly LiveAgentView[] = view.liveAgents,
): Observation {
  const liveNames = new Map(view.liveAgents.map((agent) => [agent.id, agent.name]));
  return {
    work: new Map(
      view.work.map((work) => [
        work.issueNumber,
        {
          label: `#${work.issueNumber} “${work.title}”`,
          status: work.status,
          assigneeId: work.assigneeId,
          assignee: work.assignee,
          pullRequest: work.pullRequest,
          note: work.note,
        },
      ]),
    ),
    liveAgents: new Map(
      view.liveAgents.map((agent) => [
        agent.id,
        { name: agent.name, working: isLiveAgentOnTask(agent.status), task: agent.task },
      ]),
    ),
    waiting: new Map(
      floor
        .filter((agent) => agent.status === LIVE_AGENT_STATUS.needsInput)
        .map((agent) => [agent.id, { name: agent.name, activity: agent.activity, task: agent.task }]),
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

  for (const [number, work] of after.work) {
    // Work is new between two looks only when it was just handed out, which
    // makes it assigned all the same: a runner can start it within one look.
    const previous = before.work.get(number);
    const was = previous?.status ?? WORK_STATUS.assigned;
    const who = work.assignee ?? "Its assignee";
    if (was === WORK_STATUS.assigned && work.status === WORK_STATUS.in_progress) {
      lines.push(`${who} started on ${work.label}.`);
    }
    if ((was === WORK_STATUS.assigned || was === WORK_STATUS.in_progress) && work.status === WORK_STATUS.review) {
      lines.push(
        work.pullRequest === undefined
          ? `${who} handed in ${work.label} for your review.`
          : `${who} opened ${work.pullRequest.reference} for ${work.label} and handed it in for your review: ${work.pullRequest.url}`,
      );
    }
    const noted = previous?.assigneeId === work.assigneeId ? previous.note : undefined;
    if (work.note !== undefined && work.note !== noted) {
      lines.push(`${who} couldn't work on ${work.label}: ${work.note}`);
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
  for (const [id, agent] of after.waiting) {
    // Once per episode: a look that still finds it waiting has nothing new to say.
    if (!before.waiting.has(id)) {
      lines.push(needsYouText(agent.name, agent.task, agent.activity));
    }
  }

  for (const [id, assignment] of after.assignments) {
    // One made and collected between two looks was pending all the same.
    const previous = before.assignments.get(id);
    const wasPending = previous === undefined || previous.status === LIVE_ASSIGNMENT_STATUS.pending;
    if (wasPending && assignment.status !== LIVE_ASSIGNMENT_STATUS.pending) {
      lines.push(`The orchestrator picked up ${assignment.label} for ${assignment.agent}.`);
    }
    if (assignment.status === LIVE_ASSIGNMENT_STATUS.dropped && previous?.status !== LIVE_ASSIGNMENT_STATUS.dropped) {
      lines.push(`${assignment.agent} did not pick up ${assignment.label}.`);
    }
  }
  return lines;
}
