/**
 * The room's handler for verifying as operator.
 *
 * Thin like the other handlers: it parses the attempt, resolves the sender,
 * charges the attempt against the sender's allowance, and asks the gate in
 * `sim/operator.ts`. A verified player is marked operator and takes the CEO
 * role through `sim/roles.ts`, announced to everyone when it changed hands; a
 * refusal is answered to the sender alone, with its reason.
 *
 * The allowance is spent before the gate is asked, on every attempt, right or
 * wrong, so it bounds guessing however the guesses fall. A client's allowance
 * goes when it leaves, so the room also keeps one allowance of wrong answers
 * for everyone; while that is spent, every attempt is refused unread. The attempt itself is
 * never logged or repeated back: the office event names who tried and whether
 * it worked, nothing more.
 */

import { type Client, type Room } from "@colyseus/core";
import {
  CEO_CHANGE,
  type CeoChangedEvent,
  CLIENT_MESSAGE,
  OPERATOR_REJECTION,
  type OfficeState,
  type OperatorRejectedEvent,
  type OperatorRejection,
  SERVER_MESSAGE,
  isHumanPlayer,
  parseOperatorVerifyMessage,
} from "@sim/shared";

import { recordOfficeEvent } from "../sim/events.js";
import { type TokenBucket, hasToken, tryConsume } from "../sim/expression.js";
import { type OperatorGate, createOperatorAttempts, createOperatorRoomFailures } from "../sim/operator.js";
import { takeCeoRole } from "../sim/roles.js";

/** What the handler needs from the room, named so a test can supply it. */
export interface OperatorHandlerHost {
  readonly state: OfficeState;
  /** Absent when the server has no operator passphrase. */
  readonly gate: OperatorGate | undefined;
  /** The room clock, which the attempt allowance refills against. */
  readonly now: () => number;
}

/** What the room keeps calling once the handler is registered. */
export interface OperatorHandlers {
  /** Drops a departed client's allowance. */
  readonly forget: (sessionId: string) => void;
}

function refuse(client: Client, rejection: OperatorRejection): void {
  client.send(SERVER_MESSAGE.operatorRejected, { rejection } satisfies OperatorRejectedEvent);
}

export function registerOperatorHandlers(
  room: Pick<Room<OfficeState>, "onMessage" | "broadcast">,
  host: OperatorHandlerHost,
): OperatorHandlers {
  const attempts = new Map<string, TokenBucket>();
  const failures = createOperatorRoomFailures(host.now());

  room.onMessage(CLIENT_MESSAGE.operatorVerify, (client, raw: unknown) => {
    const message = parseOperatorVerifyMessage(raw);
    const sender = host.state.occupants.get(client.sessionId);
    if (message === undefined || sender === undefined || !isHumanPlayer(sender)) {
      return;
    }
    if (host.gate === undefined) {
      refuse(client, OPERATOR_REJECTION.unavailable);
      return;
    }
    if (!hasToken(failures, host.now())) {
      refuse(client, OPERATOR_REJECTION.locked);
      return;
    }
    let allowance = attempts.get(client.sessionId);
    if (allowance === undefined) {
      allowance = createOperatorAttempts(host.now());
      attempts.set(client.sessionId, allowance);
    }
    if (!tryConsume(allowance, host.now())) {
      refuse(client, OPERATOR_REJECTION.throttled);
      return;
    }
    if (!host.gate.verify(message.passphrase)) {
      tryConsume(failures, host.now());
      recordOfficeEvent("operator-refused", { actor: sender.name });
      refuse(client, OPERATOR_REJECTION.wrong);
      return;
    }

    sender.operator = true;
    const previous = takeCeoRole(host.state.occupants, sender);
    recordOfficeEvent("operator-verified", { actor: sender.name });
    if (previous !== undefined) {
      room.broadcast(SERVER_MESSAGE.ceoChanged, {
        ceoId: sender.id,
        previousCeoId: previous.id,
        change: CEO_CHANGE.operator,
      } satisfies CeoChangedEvent);
    }
  });

  return { forget: (sessionId) => attempts.delete(sessionId) };
}
