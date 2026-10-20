/**
 * Cancelling a coding agent's task, or firing the agent, from the menu a long
 * press of `E` opens on the agent the player faces: who may, and why not.
 *
 * Both stop real work on the runner's host and throw away what it made, so
 * they are held to the rule that gates handing that agent work: only the CEO.
 * Only a runner's agent can be stopped from the office; an orchestrator's
 * agent runs wherever its orchestrator keeps it, out of the office's reach.
 * The server asks {@link agentActionRefusal} on every request; the client asks
 * it only to disable the menu's buttons and say why.
 *
 * Cancelling takes the agent's issue off it (`WORK_ACTION.cancel`) and has its
 * runner stop and discard the task's worktree, branch and pull request; the
 * agent stays, idle, free for new work. Firing does the same and then lets the
 * agent go: it walks out of the office carrying a box of its belongings, in
 * tears, and its runner stops reporting its slot.
 */

import { type LiveAgent, WORK_STATUS } from "./state.js";
import type { OfficeActor, WorkData } from "./work.js";

export const AGENT_ACTION = {
  cancel: "cancel",
  fire: "fire",
} as const;

export type AgentAction = (typeof AGENT_ACTION)[keyof typeof AGENT_ACTION];

export function isAgentAction(value: unknown): value is AgentAction {
  return value === AGENT_ACTION.cancel || value === AGENT_ACTION.fire;
}

/** Why a cancel or a firing was not done. Refusal changes nothing. */
export const AGENT_ACTION_REJECTION = {
  /** Only the CEO cancels an agent's task or fires it. */
  forbidden: "forbidden",
  /** Not a runner's coding agent in the office, or no longer here. */
  noAgent: "no-agent",
  /** It is already fired and on its way out. */
  leaving: "leaving",
  /** A cancel for an agent with no issue in hand. */
  noTask: "no-task",
  /** Its runner could not be told: gone silent, or too much waiting for it. */
  offline: "offline",
} as const;

export type AgentActionRejection = (typeof AGENT_ACTION_REJECTION)[keyof typeof AGENT_ACTION_REJECTION];

/** What the gate needs to know of the agent; `undefined` for nobody there. */
export interface AgentActionTarget {
  /** A runner's coding agent, whose runner the office can tell to stop. */
  readonly runnerAgent: boolean;
  readonly fired: boolean;
  /** The issue it has in hand, unfinished; `undefined` for none. See {@link heldIssue}. */
  readonly issueNumber: number | undefined;
}

/**
 * Whether an actor may cancel an agent's task or fire it, and if not, why. **The one gate.**
 *
 * @returns `undefined` when they may, else the rejection to send them.
 */
export function agentActionRefusal(
  actor: OfficeActor,
  action: AgentAction,
  target: AgentActionTarget | undefined,
): AgentActionRejection | undefined {
  if (!actor.isCeo) {
    return AGENT_ACTION_REJECTION.forbidden;
  }
  if (target === undefined || !target.runnerAgent) {
    return AGENT_ACTION_REJECTION.noAgent;
  }
  if (target.fired) {
    return AGENT_ACTION_REJECTION.leaving;
  }
  if (action === AGENT_ACTION.cancel && target.issueNumber === undefined) {
    return AGENT_ACTION_REJECTION.noTask;
  }
  return undefined;
}

/**
 * What the gate needs to know of a live agent, read the same way by the
 * server judging a request and the client drawing the menu. A runner's agent
 * is the one whose profile the CEO can edit: its runner is the office's to command.
 */
export function agentActionTarget(
  agent: Pick<LiveAgent, "id" | "profileEditable" | "fired">,
  work: Iterable<Pick<WorkData, "issueNumber" | "status" | "assigneeId">>,
): AgentActionTarget {
  return { runnerAgent: agent.profileEditable, fired: agent.fired, issueNumber: heldIssue(agent.id, work) };
}

/** The issue an agent has in hand and has not finished, or `undefined`: what a cancel takes off it. */
export function heldIssue(agentId: string, work: Iterable<Pick<WorkData, "issueNumber" | "status" | "assigneeId">>): number | undefined {
  for (const entry of work) {
    if (entry.assigneeId === agentId && entry.status !== WORK_STATUS.done) {
      return entry.issueNumber;
    }
  }
  return undefined;
}
