/**
 * The room's handler for messages to the AI manager.
 *
 * Thin for the same reason the ticket and staff handlers are: it parses the
 * untrusted payload, resolves the sender, and hands both to the manager, whose
 * `instruct` checks the one gate — `mayInstructManager`, the CEO only — and
 * queues the message. A refusal is answered to the sender alone, with its
 * reason, so an executive sees "only the CEO can instruct the manager" rather
 * than a message that vanished.
 *
 * Authority is checked before the rate limit, so a refused sender is told why
 * rather than throttled; the CEO's own messages are then charged against a
 * budget lower than chat's, since each one may become a model call.
 *
 * Synchronous: the answer comes later, from the manager's own loop.
 */

import { type Client, type Room } from "@colyseus/core";
import {
  CLIENT_MESSAGE,
  MANAGER_REJECTION,
  type ManagerRejectedEvent,
  type ManagerRejection,
  type OfficeState,
  SERVER_MESSAGE,
  mayInstructManager,
  parseManagerSayMessage,
  ticketActorOf,
} from "@sim/shared";

import type { OfficeManager } from "../manager/officeManager.js";

/** What the handler needs from the room, named so a test can supply it. */
export interface ManagerHandlerHost {
  readonly state: OfficeState;
  readonly manager: Pick<OfficeManager, "instruct">;
  /** Charges one message against the sender's budget; `false` drops it, and the limiter says so. */
  readonly allow: (client: Client) => boolean;
}

function refuse(client: Client, rejection: ManagerRejection): void {
  client.send(SERVER_MESSAGE.managerRejected, { rejection } satisfies ManagerRejectedEvent);
}

export function registerManagerHandlers(
  room: Pick<Room<OfficeState>, "onMessage">,
  host: ManagerHandlerHost,
): void {
  room.onMessage(CLIENT_MESSAGE.managerSay, (client, raw: unknown) => {
    const message = parseManagerSayMessage(raw);
    const sender = host.state.occupants.get(client.sessionId);
    if (message === undefined || sender === undefined) {
      return;
    }
    if (!mayInstructManager(ticketActorOf(sender))) {
      refuse(client, MANAGER_REJECTION.forbidden);
      return;
    }
    if (!host.allow(client)) {
      return;
    }
    const rejection = host.manager.instruct(sender, message.text);
    if (rejection !== undefined) {
      refuse(client, rejection);
    }
  });
}
