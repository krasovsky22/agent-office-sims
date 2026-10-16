/**
 * The room's work command handlers: handing the project board's issues to
 * agents, and moving the work on them.
 *
 * Thin by design. Each handler does three things and nothing else: parse the
 * untrusted payload, resolve the sender to an {@link OfficeActor}, and hand both
 * to `applyWorkCommand`, which owns every rule. No handler reads a status, a
 * transition or an authority rule of its own: who may do what is decided once,
 * by `mayActOnWork` in `@sim/shared`'s `work.ts`, and this file is not it.
 *
 * A refused command is answered, to its sender only, with the reason. The
 * office is unchanged either way; the answer is what lets an executive's
 * client say "only the CEO can do that" instead of nothing.
 *
 * All of it is synchronous. Colyseus delivers a room's messages one at a time,
 * so the work is only ever mutated between simulation ticks and the tick never
 * has to wait on a command. The project board is read as the feed last
 * published it, which is already in memory; nothing here waits on GitHub, and
 * nothing here writes to it.
 */

import { type Client, type Room } from "@colyseus/core";
import {
  CLIENT_MESSAGE,
  type OfficeActor,
  type OfficeState,
  type ProjectBoardSnapshot,
  SERVER_MESSAGE,
  WORK_ACTION,
  type WorkCommand,
  type WorkCommandResult,
  type WorkRejectedEvent,
  actorOf,
  applyWorkCommand,
  parseWorkAssignMessage,
  parseWorkMoveMessage,
  parseWorkReleaseMessage,
} from "@sim/shared";

/** What the handlers need from the room, named so a test can supply it. */
export interface WorkHost {
  readonly state: OfficeState;
  /** Epoch milliseconds to stamp on a change. */
  readonly now: () => number;
  /** The project board as the feed last published it; `undefined` before its first poll. */
  readonly board: () => ProjectBoardSnapshot | undefined;
}

/**
 * Resolves a connected client to the actor the authority seam will judge.
 *
 * An occupant that is not in the map — a message that arrived in the gap
 * between a disconnect and its `onLeave` — yields `undefined`, and the command
 * is dropped. The alternative, inventing a default actor, would hand a
 * disconnected session the permissions of a present one.
 */
function actorFor(state: OfficeState, client: Client): OfficeActor | undefined {
  const occupant = state.occupants.get(client.sessionId);
  return occupant === undefined ? undefined : actorOf(occupant);
}

/** Applies a command as `actor`, against the office and the board as they are now. */
export function applyAs(host: WorkHost, actor: OfficeActor, command: WorkCommand): WorkCommandResult {
  return applyWorkCommand(command, {
    work: host.state.work,
    occupants: host.state.occupants,
    board: host.board(),
    actor,
    now: host.now(),
  });
}

/**
 * Runs one command on behalf of a client.
 *
 * The actor is resolved from the replicated occupant at the moment the command
 * arrives, so the role it is judged by is the role the server holds now — not
 * one the client claims, and not one it held before a succession.
 *
 * @returns the result, or `undefined` if the sender did not resolve. A
 * rejection leaves the office unchanged and is reported to the sender as a
 * {@link WorkRejectedEvent}.
 */
export function runWorkCommand(
  host: WorkHost,
  client: Client,
  command: WorkCommand,
): WorkCommandResult | undefined {
  const actor = actorFor(host.state, client);
  if (actor === undefined) {
    return undefined;
  }
  const result = applyAs(host, actor, command);
  if (!result.ok) {
    client.send(SERVER_MESSAGE.workRejected, {
      action: command.action,
      rejection: result.rejection,
    } satisfies WorkRejectedEvent);
  }
  return result;
}

/**
 * Registers the three work handlers on a room.
 *
 * Takes the room's `onMessage` rather than the room, so the host object above
 * stays the whole of what these handlers can reach.
 */
export function registerWorkHandlers(room: Pick<Room<OfficeState>, "onMessage">, host: WorkHost): void {
  room.onMessage(CLIENT_MESSAGE.workAssign, (client, raw: unknown) => {
    const payload = parseWorkAssignMessage(raw);
    if (payload !== undefined) {
      runWorkCommand(host, client, { action: WORK_ACTION.assign, payload });
    }
  });

  room.onMessage(CLIENT_MESSAGE.workRelease, (client, raw: unknown) => {
    const payload = parseWorkReleaseMessage(raw);
    if (payload !== undefined) {
      runWorkCommand(host, client, { action: WORK_ACTION.release, payload });
    }
  });

  room.onMessage(CLIENT_MESSAGE.workMove, (client, raw: unknown) => {
    const payload = parseWorkMoveMessage(raw);
    if (payload !== undefined) {
      runWorkCommand(host, client, { action: WORK_ACTION.moveStatus, payload });
    }
  });
}
