/**
 * The room's handlers for the roster's standing task buttons: pause, resume,
 * remove and check now.
 *
 * Thin, like the work's: each parses the untrusted payload, resolves the
 * sender, and hands both to `../agents/standingControl.ts`, which asks the
 * one gate, `mayManageStandingTasks` (the CEO), and queues the command for
 * the task's runner. A refusal is answered to the sender alone, with its
 * reason, so an executive's client can say "only the CEO can" rather than
 * nothing.
 *
 * Authority is checked before the rate limit, so a refused sender is told
 * why rather than throttled; the CEO's commands then share one allowance,
 * since each waits in a runner's queue beside issue work.
 */

import { type Client, type Room } from "@colyseus/core";
import {
  CLIENT_MESSAGE,
  type OfficeState,
  SERVER_MESSAGE,
  STANDING_ACTION,
  STANDING_REJECTION,
  type StandingClientMessage,
  type StandingRejectedEvent,
  type StandingTaskAction,
  actorOf,
  mayManageStandingTasks,
  parseStandingTaskMessage,
} from "@sim/shared";

import type { StandingControl } from "../agents/standingControl.js";

/** What the handlers need from the room, named so a test can supply it. */
export interface StandingHandlerHost {
  readonly state: OfficeState;
  readonly control: Pick<StandingControl, "act">;
  /** Charges one command against the sender's budget; `false` drops it, and the limiter says so. */
  readonly allow: (client: Client, command: StandingClientMessage) => boolean;
}

const ACTIONS: ReadonlyArray<readonly [StandingClientMessage, StandingTaskAction]> = [
  [CLIENT_MESSAGE.standingPause, STANDING_ACTION.pause],
  [CLIENT_MESSAGE.standingResume, STANDING_ACTION.resume],
  [CLIENT_MESSAGE.standingRemove, STANDING_ACTION.remove],
  [CLIENT_MESSAGE.standingCheckNow, STANDING_ACTION.checkNow],
];

export function registerStandingHandlers(room: Pick<Room<OfficeState>, "onMessage">, host: StandingHandlerHost): void {
  for (const [type, action] of ACTIONS) {
    room.onMessage(type, (client, raw: unknown) => {
      const message = parseStandingTaskMessage(raw);
      const sender = host.state.occupants.get(client.sessionId);
      if (message === undefined || sender === undefined) {
        return;
      }
      const actor = actorOf(sender);
      const refuse = (rejection: StandingRejectedEvent["rejection"]): void => {
        client.send(SERVER_MESSAGE.standingRejected, { action, taskId: message.taskId, rejection } satisfies StandingRejectedEvent);
      };
      if (!mayManageStandingTasks(actor)) {
        refuse(STANDING_REJECTION.forbidden);
        return;
      }
      if (!host.allow(client, type)) {
        return;
      }
      const result = host.control.act(actor, sender.name, action, message.taskId);
      if (!result.ok) {
        refuse(result.rejection);
      }
    });
  }
}
