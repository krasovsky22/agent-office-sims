/**
 * The room's handler for the CEO's prompts to the coding agents.
 *
 * Thin, like the manager's: it parses the untrusted payload, resolves the
 * sender, asks the one gate, `agentPromptRefusal` in `@sim/shared` (only the
 * CEO), and hands the prompt to
 * `../agents/agentPrompts.ts`, which queues it for the agent's runner. A
 * refusal is answered to the sender alone, with its reason.
 *
 * Authority is checked before the rate limit, so a refused sender is told why
 * rather than throttled; the CEO's prompts are then charged against a budget of
 * their own, since each one starts a real agent's turn.
 */

import { type Client, type Room } from "@colyseus/core";
import {
  type AgentPromptRejectedEvent,
  type AgentPromptRejection,
  CLIENT_MESSAGE,
  type OfficeState,
  SERVER_MESSAGE,
  actorOf,
  agentPromptRefusal,
  parseAgentPromptMessage,
} from "@sim/shared";

import type { AgentPrompts } from "../agents/agentPrompts.js";

/** What the handler needs from the room, named so a test can supply it. */
export interface AgentPromptHandlerHost {
  readonly state: OfficeState;
  readonly prompts: Pick<AgentPrompts, "submit">;
  /** Charges one prompt against the sender's budget; `false` drops it, and the limiter says so. */
  readonly allow: (client: Client) => boolean;
}

function refuse(client: Client, agentId: string, rejection: AgentPromptRejection): void {
  client.send(SERVER_MESSAGE.agentPromptRejected, { agentId, rejection } satisfies AgentPromptRejectedEvent);
}

export function registerAgentPromptHandlers(
  room: Pick<Room<OfficeState>, "onMessage">,
  host: AgentPromptHandlerHost,
): void {
  room.onMessage(CLIENT_MESSAGE.agentPrompt, (client, raw: unknown) => {
    const message = parseAgentPromptMessage(raw);
    const sender = host.state.occupants.get(client.sessionId);
    if (message === undefined || sender === undefined) {
      return;
    }
    const refusal = agentPromptRefusal(actorOf(sender));
    if (refusal !== undefined) {
      refuse(client, message.agentId, refusal);
      return;
    }
    if (!host.allow(client)) {
      return;
    }
    const rejection = host.prompts.submit(client.sessionId, message);
    if (rejection !== undefined) {
      refuse(client, message.agentId, rejection);
    }
  });
}
