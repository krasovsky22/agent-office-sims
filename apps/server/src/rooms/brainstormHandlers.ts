/**
 * The room's handlers for brainstorm tickets: hand an idea to several agents,
 * gather them to discuss it, mark its design document reviewed, and convert
 * it into implementation issues.
 *
 * Thin, like the work handlers: parse the untrusted payload, find the sender,
 * charge the command to their allowance, and ask `../agents/brainstorms.ts`,
 * which owns the rules through `@sim/shared`'s `brainstorm.ts`. A command
 * taken has no reply but the next patch; a refused one is answered to its
 * sender alone, with the reason.
 */

import { type Client, type Room } from "@colyseus/core";
import {
  BRAINSTORM_ACTION,
  type BrainstormClientMessage,
  type BrainstormRejectedEvent,
  type BrainstormRejection,
  CLIENT_MESSAGE,
  type Occupant,
  type OfficeState,
  SERVER_MESSAGE,
  parseBrainstormAssignMessage,
  parseBrainstormConvertMessage,
  parseBrainstormIssueMessage,
} from "@sim/shared";

import type { Brainstorms } from "../agents/brainstorms.js";

export interface BrainstormHandlerHost {
  readonly state: OfficeState;
  readonly brainstorms: Pick<Brainstorms, "assign" | "act" | "convert">;
  /** Charges one command against the sender's allowance; `false` drops it, and the limiter says so. */
  readonly allow: (client: Client, command: BrainstormClientMessage) => boolean;
}

export function registerBrainstormHandlers(room: Pick<Room<OfficeState>, "onMessage">, host: BrainstormHandlerHost): void {
  /** Runs one command for its sender, if it parsed and the sender may send one, and answers a refusal. */
  const handle = <T extends { readonly issueNumber: number }>(
    command: BrainstormClientMessage,
    parse: (raw: unknown) => T | undefined,
    run: (sender: Occupant, message: T) => BrainstormRejection | undefined,
  ): void => {
    room.onMessage(command, (client, raw: unknown) => {
      const message = parse(raw);
      const sender = host.state.occupants.get(client.sessionId);
      if (message === undefined || sender === undefined || !host.allow(client, command)) {
        return;
      }
      const rejection = run(sender, message);
      if (rejection !== undefined) {
        client.send(SERVER_MESSAGE.brainstormRejected, { issueNumber: message.issueNumber, rejection } satisfies BrainstormRejectedEvent);
      }
    });
  };
  handle(CLIENT_MESSAGE.brainstormAssign, parseBrainstormAssignMessage, (sender, message) => host.brainstorms.assign(sender, message));
  handle(CLIENT_MESSAGE.brainstormMeet, parseBrainstormIssueMessage, (sender, message) =>
    host.brainstorms.act(sender, BRAINSTORM_ACTION.meet, message.issueNumber),
  );
  handle(CLIENT_MESSAGE.brainstormReview, parseBrainstormIssueMessage, (sender, message) =>
    host.brainstorms.act(sender, BRAINSTORM_ACTION.review, message.issueNumber),
  );
  handle(CLIENT_MESSAGE.brainstormConvert, parseBrainstormConvertMessage, (sender, message) => host.brainstorms.convert(sender, message));
}
