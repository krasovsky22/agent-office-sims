/**
 * Gets the lobby board's snapshot from the feed to every client in a room.
 *
 * Two paths, and both are needed. A client joining gets the current snapshot
 * on its own, because a broadcast it was not there for will not be repeated;
 * everyone already in the room gets each replacement as the feed publishes it.
 * Between them every client holds the snapshot the feed holds, which is what
 * makes two tabs show the same board.
 *
 * Both paths are synchronous. The feed does its waiting on its own timer and
 * calls in here with a finished snapshot, so nothing on the room's side of
 * this ever awaits — least of all the simulation tick, which does not touch
 * the board at all.
 */

import { SERVER_MESSAGE, type ProjectBoardSnapshot } from "@sim/shared";

import type { ProjectBoardSource } from "../github/feed.js";

/** The slice of a Colyseus room these functions use, named so a test can supply it. */
export interface BoardRoom {
  broadcast(type: typeof SERVER_MESSAGE.projectBoard, message: ProjectBoardSnapshot): void;
}

/** The slice of a Colyseus client these functions use. */
export interface BoardClient {
  send(type: typeof SERVER_MESSAGE.projectBoard, message: ProjectBoardSnapshot): void;
}

/**
 * Whether a room option is a feed the server handed over, rather than whatever
 * a client put in its join options under the same name.
 *
 * Colyseus merges the two, server options winning, so this is belt and braces:
 * a JSON payload cannot carry a function, so it can never pass.
 */
export function isProjectBoardSource(value: unknown): value is ProjectBoardSource {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof ProjectBoardSource, unknown>>;
  return typeof candidate.current === "function" && typeof candidate.subscribe === "function";
}

/**
 * Relays every snapshot the feed publishes to the room.
 *
 * @returns the unsubscribe, for the room's `onDispose`; a disposed room left
 * subscribed would be broadcast to for the life of the process.
 */
export function relayProjectBoard(room: BoardRoom, source: ProjectBoardSource): () => void {
  return source.subscribe((snapshot) => {
    room.broadcast(SERVER_MESSAGE.projectBoard, snapshot);
  });
}

/**
 * Sends a joining client the snapshot the room already has, if there is one.
 *
 * Before the feed's first poll has answered there is nothing to send; that
 * first answer reaches this client as a broadcast like everyone else's.
 */
export function sendProjectBoard(client: BoardClient, source: ProjectBoardSource): void {
  const snapshot = source.current();
  if (snapshot !== undefined) {
    client.send(SERVER_MESSAGE.projectBoard, snapshot);
  }
}
