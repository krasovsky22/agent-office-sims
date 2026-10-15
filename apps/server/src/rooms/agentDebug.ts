/**
 * The room's debug command: send a named agent walking.
 *
 * It exists so the whole locomotion layer can be driven with no brain
 * attached — a person types `/goto ada wp-meeting-table` and watches the route
 * in both tabs. It pushes an intent onto the same queue a brain will, through
 * the same validation, so what it exercises is the real path rather than a
 * shortcut beside it.
 *
 * Off unless the server is started with `AGENT_DEBUG=on`: any visitor to a
 * deployment could otherwise march the staff around. Each command is answered,
 * to its sender only, so a typo is a line on the HUD rather than an agent that
 * silently stays put.
 */

import { type Client, type Room } from "@colyseus/core";
import {
  type AgentEmployee,
  CLIENT_MESSAGE,
  type DebugGotoMessage,
  type DebugReplyEvent,
  type Occupant,
  SERVER_MESSAGE,
  isAgentEmployee,
  parseDebugGotoMessage,
} from "@sim/shared";

import { type AgentMotion, intent } from "../sim/agentMotion.js";

/** What the handler needs from the room, named so a test can supply it. */
export interface AgentDebugHost {
  /** Whether `AGENT_DEBUG` is on for this server. */
  readonly enabled: boolean;
  readonly motion: AgentMotion;
  readonly occupants: { values(): Iterable<Occupant> };
}

/**
 * The agent a person means: by id, by full name, or by first name, ignoring
 * case. First names are unique on the roster, which is what makes the short
 * form safe to accept.
 */
export function findAgent(
  occupants: Iterable<Occupant>,
  query: string,
): AgentEmployee | undefined {
  const wanted = query.trim().toLowerCase();
  for (const occupant of occupants) {
    if (!isAgentEmployee(occupant)) {
      continue;
    }
    const name = occupant.name.toLowerCase();
    if (occupant.id === query || name === wanted || name.split(" ")[0] === wanted) {
      return occupant;
    }
  }
  return undefined;
}

/** Queues the goto a debug command asked for, and says what came of it. */
export function runDebugGoto(host: AgentDebugHost, message: DebugGotoMessage): DebugReplyEvent {
  if (!host.enabled) {
    return { ok: false, text: "Debug commands are off on this server (AGENT_DEBUG)." };
  }
  const agent = findAgent(host.occupants.values(), message.agent);
  if (agent === undefined) {
    return { ok: false, text: `No agent called ${message.agent}.` };
  }
  const result = host.motion.enqueue(agent.id, intent.goto(message.target));
  const where =
    typeof message.target === "string"
      ? message.target
      : `${message.target.x.toFixed(2)}, ${message.target.z.toFixed(2)}`;
  return result.accepted
    ? { ok: true, text: `${agent.name} is heading to ${where}.` }
    : { ok: false, text: `${agent.name} cannot go to ${where}: ${result.reason}.` };
}

export function registerAgentDebugHandlers(room: Room, host: AgentDebugHost): void {
  room.onMessage(CLIENT_MESSAGE.debugGoto, (client: Client, raw: unknown) => {
    const message = parseDebugGotoMessage(raw);
    if (message === undefined) {
      return;
    }
    client.send(SERVER_MESSAGE.debugReply, runDebugGoto(host, message) satisfies DebugReplyEvent);
  });
}
