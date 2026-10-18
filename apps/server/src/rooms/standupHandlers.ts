/**
 * The room's handlers for the CEO's standup commands: call one, end it, and
 * give a direction at it.
 *
 * Thin, like the manager's: each parses the untrusted payload, resolves the
 * sender, asks the one gate, `mayRunStandup` in `@sim/shared` (only the CEO),
 * and hands the command to `../sim/standup.ts`. A refusal is answered to the
 * sender alone, with its reason; a command taken has no reply but the next
 * patch, since the standup is state.
 *
 * Authority is checked before the rate limit, so a refused sender is told why
 * rather than throttled. Calling and ending share a budget, since each walks
 * every agent across the office; a direction is charged against one of its
 * own, since each may start a real agent's turn.
 */

import { type Client, type Room } from "@colyseus/core";
import {
  CLIENT_MESSAGE,
  type OfficeState,
  SERVER_MESSAGE,
  STANDUP_REJECTION,
  type StandupRejectedEvent,
  actorOf,
  mayRunStandup,
  parseStandupDirectMessage,
} from "@sim/shared";

import type { StandupMeeting } from "../sim/standup.js";

/** What the handlers need from the room, named so a test can supply it. */
export interface StandupHandlerHost {
  readonly state: OfficeState;
  readonly standup: Pick<StandupMeeting, "start" | "end" | "direct">;
  /** Charges one call or end against the sender's budget; `false` drops it, and the limiter says so. */
  readonly allowCall: (client: Client) => boolean;
  /** Charges one direction against the sender's budget; `false` drops it, and the limiter says so. */
  readonly allowDirection: (client: Client) => boolean;
}

function refuse(client: Client, event: StandupRejectedEvent): void {
  client.send(SERVER_MESSAGE.standupRejected, event);
}

export function registerStandupHandlers(room: Pick<Room<OfficeState>, "onMessage">, host: StandupHandlerHost): void {
  for (const command of [CLIENT_MESSAGE.standupStart, CLIENT_MESSAGE.standupEnd] as const) {
    room.onMessage(command, (client) => {
      const sender = host.state.occupants.get(client.sessionId);
      if (sender === undefined) {
        return;
      }
      if (!mayRunStandup(actorOf(sender))) {
        refuse(client, { command, rejection: STANDUP_REJECTION.forbidden });
        return;
      }
      if (!host.allowCall(client)) {
        return;
      }
      const rejection = command === CLIENT_MESSAGE.standupStart ? host.standup.start(sender) : host.standup.end(sender);
      if (rejection !== undefined) {
        refuse(client, { command, rejection });
      }
    });
  }

  room.onMessage(CLIENT_MESSAGE.standupDirect, (client, raw: unknown) => {
    const message = parseStandupDirectMessage(raw);
    const sender = host.state.occupants.get(client.sessionId);
    if (message === undefined || sender === undefined) {
      return;
    }
    const command = CLIENT_MESSAGE.standupDirect;
    if (!mayRunStandup(actorOf(sender))) {
      refuse(client, { command, rejection: STANDUP_REJECTION.forbidden });
      return;
    }
    if (!host.allowDirection(client)) {
      return;
    }
    const rejection = host.standup.direct(sender, message);
    if (rejection !== undefined) {
      refuse(client, { command, rejection });
    }
  });
}
