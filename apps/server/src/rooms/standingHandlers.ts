/**
 * The room's handlers for the roster's and the wall board's standing task
 * buttons: pause, resume, remove, check now and a new schedule, the wall
 * board's form for a new task, and its ask for a task's last runs.
 *
 * Thin, like the work's: each parses the untrusted payload, resolves the
 * sender (and, for a new task, the agent it is to run on, which must be one
 * of a runner's coding agents), and hands them to
 * `../agents/standingControl.ts`, which asks the
 * one gate, `mayManageStandingTasks` (the CEO), and queues the command for
 * the task's runner. A refusal is answered to the sender alone, with its
 * reason, so an executive's client can say "only the CEO can" rather than
 * nothing.
 *
 * Authority is checked before the rate limit, so a refused sender is told
 * why rather than throttled; the CEO's commands then share one allowance,
 * since each waits in a runner's queue beside issue work. A task's runs are
 * anyone's to read, as everyone reads the agents' screens they come off, on
 * an allowance of their own, and answered to the sender alone.
 */

import { type Client, type Room } from "@colyseus/core";
import {
  CLIENT_MESSAGE,
  type OfficeState,
  SERVER_MESSAGE,
  STANDING_ACTION,
  STANDING_KIND,
  STANDING_REJECTION,
  type StandingClientMessage,
  type StandingHistoryEvent,
  type StandingRejectedEvent,
  type StandingRunView,
  type StandingTaskAction,
  actorOf,
  isIssueAssignee,
  isLiveAgent,
  mayManageStandingTasks,
  parseStandingCreateMessage,
  parseStandingRescheduleMessage,
  parseStandingTaskMessage,
} from "@sim/shared";

import { slotOf } from "../agents/runnerWork.js";
import type { StandingControl, StandingPlacement } from "../agents/standingControl.js";

/** What the handlers need from the room, named so a test can supply it. */
export interface StandingHandlerHost {
  readonly state: OfficeState;
  readonly control: Pick<StandingControl, "act" | "reschedule" | "create">;
  /** Charges one command against the sender's budget; `false` drops it, and the limiter says so. */
  readonly allow: (client: Client, command: StandingClientMessage | typeof CLIENT_MESSAGE.standingHistory) => boolean;
  /** A task's last runs, newest first, with their links built on the board's repository. */
  readonly history: (taskId: string) => readonly StandingRunView[];
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

  room.onMessage(CLIENT_MESSAGE.standingReschedule, (client, raw: unknown) => {
    const message = parseStandingRescheduleMessage(raw);
    const sender = host.state.occupants.get(client.sessionId);
    if (message === undefined || sender === undefined) {
      return;
    }
    const actor = actorOf(sender);
    const refuse = (rejection: StandingRejectedEvent["rejection"]): void => {
      client.send(SERVER_MESSAGE.standingRejected, { action: STANDING_ACTION.reschedule, taskId: message.taskId, rejection } satisfies StandingRejectedEvent);
    };
    if (!mayManageStandingTasks(actor)) {
      refuse(STANDING_REJECTION.forbidden);
      return;
    }
    if (!host.allow(client, CLIENT_MESSAGE.standingReschedule)) {
      return;
    }
    const result = host.control.reschedule(actor, sender.name, message.taskId, message.schedule);
    if (!result.ok) {
      refuse(result.rejection);
    }
  });

  room.onMessage(CLIENT_MESSAGE.standingCreate, (client, raw: unknown) => {
    const message = parseStandingCreateMessage(raw);
    const sender = host.state.occupants.get(client.sessionId);
    if (message === undefined || sender === undefined) {
      return;
    }
    const actor = actorOf(sender);
    const refuse = (rejection: StandingRejectedEvent["rejection"]): void => {
      client.send(SERVER_MESSAGE.standingRejected, { action: STANDING_ACTION.create, taskId: "", rejection } satisfies StandingRejectedEvent);
    };
    if (!mayManageStandingTasks(actor)) {
      refuse(STANDING_REJECTION.forbidden);
      return;
    }
    if (!host.allow(client, CLIENT_MESSAGE.standingCreate)) {
      return;
    }
    let placement: StandingPlacement | undefined;
    if (message.agentId !== "") {
      const agent = host.state.occupants.get(message.agentId);
      const slot = slotOf(message.agentId);
      if (agent === undefined || !isLiveAgent(agent) || !isIssueAssignee(actorOf(agent)) || slot === undefined) {
        refuse(STANDING_REJECTION.invalid);
        return;
      }
      placement = { runnerId: slot.runnerId, agent: slot.slotId };
    }
    const request =
      message.kind === STANDING_KIND.schedule ? { kind: message.kind, cron: message.cron, instruction: message.instruction } : { kind: message.kind };
    const result = host.control.create(actor, sender.name, request, "", placement);
    if (!result.ok) {
      refuse(result.rejection);
    }
  });

  room.onMessage(CLIENT_MESSAGE.standingHistory, (client, raw: unknown) => {
    const message = parseStandingTaskMessage(raw);
    if (message === undefined || !host.state.occupants.has(client.sessionId) || !host.allow(client, CLIENT_MESSAGE.standingHistory)) {
      return;
    }
    client.send(SERVER_MESSAGE.standingHistory, { taskId: message.taskId, runs: host.history(message.taskId) } satisfies StandingHistoryEvent);
  });
}
