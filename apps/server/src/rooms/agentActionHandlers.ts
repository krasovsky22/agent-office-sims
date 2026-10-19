/**
 * The room's handler for the CEO's long-press `E` menu on a coding agent:
 * cancel its task, or fire it.
 *
 * Thin, like the profile handler: it parses the untrusted payload, resolves
 * the sender and the agent, and asks the one gate, `agentActionRefusal` in
 * `@sim/shared`. A cancel is the work command `cancel`, applied through the
 * work rules like any other, which is what tells the agent's runner to stop
 * and discard the task (`../agents/runnerWork.ts`). A firing queues `fire`
 * for the runner, which discards whatever the slot runs and stops reporting
 * it, cancels the agent's work the same way, and has the crew walk the agent
 * out of the office. A refusal is answered to the sender alone, with its
 * reason.
 *
 * Authority is checked before the rate limit, so a refused sender is told why
 * rather than throttled.
 */

import { type Client, type Room } from "@colyseus/core";
import {
  AGENT_ACTION,
  AGENT_ACTION_REJECTION,
  type AgentAction,
  type AgentActionRejectedEvent,
  type AgentActionRejection,
  CLIENT_MESSAGE,
  type OfficeState,
  RUNNER_COMMAND_KIND,
  SERVER_MESSAGE,
  WORK_ACTION,
  actorOf,
  agentActionRefusal,
  agentActionTarget,
  isLiveAgent,
  parseAgentActionMessage,
} from "@sim/shared";

import { type RunnerCommands, slotOf } from "../agents/runnerWork.js";
import { type WorkHost, applyAs } from "./workHandlers.js";

/** What the handler needs from the room, named so a test can supply it. */
export interface AgentActionHandlerHost {
  /** Where cancelled work goes through the work rules, and on to the agent's runner. */
  readonly work: WorkHost;
  /** Where a firing is queued for the agent's runner; absent when the server has no runner. */
  readonly runner: Pick<RunnerCommands, "enqueue"> | undefined;
  /** Walks a fired agent out of the office, by occupant key. */
  readonly fire: (agentId: string) => void;
  /** Says something to the office as the AI Manager. */
  readonly announce?: (text: string) => void;
  /** Charges one action against the sender's budget; `false` drops it, and the limiter says so. */
  readonly allow: (client: Client) => boolean;
  readonly log?: (name: string, detail: Record<string, string | number>) => void;
}

function refuse(client: Client, agentId: string, action: AgentAction, rejection: AgentActionRejection): void {
  client.send(SERVER_MESSAGE.agentActionRejected, { agentId, action, rejection } satisfies AgentActionRejectedEvent);
}

export function registerAgentActionHandlers(room: Pick<Room<OfficeState>, "onMessage">, host: AgentActionHandlerHost): void {
  const { state } = host.work;
  room.onMessage(CLIENT_MESSAGE.agentAction, (client, raw: unknown) => {
    const message = parseAgentActionMessage(raw);
    const sender = state.occupants.get(client.sessionId);
    if (message === undefined || sender === undefined) {
      return;
    }
    const { agentId, action } = message;
    const agent = state.occupants.get(agentId);
    const target = agent !== undefined && isLiveAgent(agent) ? agentActionTarget(agent, state.work.values()) : undefined;
    const actor = actorOf(sender);
    const refusal = agentActionRefusal(actor, action, target);
    if (refusal !== undefined) {
      refuse(client, agentId, action, refusal);
      return;
    }
    if (!host.allow(client)) {
      return;
    }
    const slot = slotOf(agentId);
    if (slot === undefined || host.runner === undefined || target === undefined || agent === undefined) {
      refuse(client, agentId, action, AGENT_ACTION_REJECTION.noAgent);
      return;
    }
    if (action === AGENT_ACTION.fire) {
      // First, so a refusal changes nothing; the runner discards the task with the slot.
      const command = host.runner.enqueue(slot.runnerId, { kind: RUNNER_COMMAND_KIND.fire, slotId: slot.slotId, requestedBy: sender.name });
      host.log?.(command === undefined ? "agent-fire-refused" : "agent-fire", { agent: agentId, by: sender.name });
      if (command === undefined) {
        refuse(client, agentId, action, AGENT_ACTION_REJECTION.offline);
        return;
      }
    }
    const issueNumber = target.issueNumber;
    if (issueNumber !== undefined) {
      applyAs(host.work, actor, { action: WORK_ACTION.cancel, payload: { issueNumber } });
      host.log?.("agent-cancel", { agent: agentId, by: sender.name, issue: issueNumber });
    }
    if (action === AGENT_ACTION.fire) {
      host.fire(agentId);
      host.announce?.(`${sender.name} fired ${agent.name}${issueNumber === undefined ? "" : `, whose work on #${issueNumber} was thrown away`}.`);
    } else if (issueNumber !== undefined) {
      host.announce?.(`${sender.name} cancelled ${agent.name}'s task #${issueNumber}; what it had done is thrown away.`);
    }
  });
}
