/**
 * The room's handler for the CEO's edits to a coding agent's profile: its
 * name, title and description, which its runner also gives the agent as its
 * system prompt.
 *
 * Thin, like the prompt handlers: it parses the untrusted payload, resolves
 * the sender, asks the one gate, `agentProfileRefusal` in `@sim/shared` (only
 * the CEO), refuses a name anyone else in the office already has
 * (`nameRefusal`, the rule players' names follow), and queues the edit for the agent's runner as a `profile`
 * command. The runner keeps the profile and reports it on its next sync,
 * which is what changes the agent on the floor; until then nothing here does.
 * A refusal is answered to the sender alone, with its reason.
 *
 * Authority is checked before the rate limit, so a refused sender is told why
 * rather than throttled; the CEO's edits are then charged against a budget of
 * their own, since a runner writes each one to disk.
 */

import { type Client, type Room } from "@colyseus/core";
import {
  AGENT_PROFILE_REJECTION,
  type AgentProfileRejectedEvent,
  type AgentProfileRejection,
  CLIENT_MESSAGE,
  type OfficeState,
  RUNNER_COMMAND_KIND,
  SERVER_MESSAGE,
  actorOf,
  NAME_REJECTION,
  agentProfileRefusal,
  isLiveAgent,
  nameRefusal,
  parseAgentProfileMessage,
} from "@sim/shared";

import { type RunnerCommands, slotOf } from "../agents/runnerWork.js";

/** What the handler needs from the room, named so a test can supply it. */
export interface AgentProfileHandlerHost {
  readonly state: OfficeState;
  /** Where the edit is queued for the agent's runner; absent when the server has no runner. */
  readonly runner: Pick<RunnerCommands, "enqueue"> | undefined;
  /** Charges one edit against the sender's budget; `false` drops it, and the limiter says so. */
  readonly allow: (client: Client) => boolean;
  readonly log?: (name: string, detail: Record<string, string | number>) => void;
}

function refuse(client: Client, agentId: string, name: string, rejection: AgentProfileRejection): void {
  client.send(SERVER_MESSAGE.agentProfileRejected, { agentId, name, rejection } satisfies AgentProfileRejectedEvent);
}

export function registerAgentProfileHandlers(room: Pick<Room<OfficeState>, "onMessage">, host: AgentProfileHandlerHost): void {
  room.onMessage(CLIENT_MESSAGE.agentProfile, (client, raw: unknown) => {
    const message = parseAgentProfileMessage(raw);
    const sender = host.state.occupants.get(client.sessionId);
    if (message === undefined || sender === undefined) {
      return;
    }
    const refusal = agentProfileRefusal(actorOf(sender));
    if (refusal !== undefined) {
      refuse(client, message.agentId, message.name, refusal);
      return;
    }
    if (!host.allow(client)) {
      return;
    }
    const agent = host.state.occupants.get(message.agentId);
    const slot = slotOf(message.agentId);
    if (agent === undefined || !isLiveAgent(agent) || !agent.profileEditable || slot === undefined || host.runner === undefined) {
      refuse(client, message.agentId, message.name, AGENT_PROFILE_REJECTION.noAgent);
      return;
    }
    const renamed = message.name.toLowerCase() !== agent.name.toLowerCase();
    const others = [...host.state.occupants.values()].filter((occupant) => occupant !== agent);
    const taken = renamed ? nameRefusal(message.name, others) : undefined;
    if (taken !== undefined) {
      refuse(
        client,
        message.agentId,
        message.name,
        taken === NAME_REJECTION.taken ? AGENT_PROFILE_REJECTION.nameTaken : AGENT_PROFILE_REJECTION.nameReserved,
      );
      return;
    }
    const command = host.runner.enqueue(slot.runnerId, {
      kind: RUNNER_COMMAND_KIND.profile,
      slotId: slot.slotId,
      name: message.name,
      title: message.title,
      description: message.description,
      requestedBy: sender.name,
    });
    host.log?.(command === undefined ? "agent-profile-refused" : "agent-profile", {
      agent: message.agentId,
      by: sender.name,
      name: message.name,
      title: message.title,
    });
    if (command === undefined) {
      refuse(client, message.agentId, message.name, AGENT_PROFILE_REJECTION.offline);
    }
  });
}
