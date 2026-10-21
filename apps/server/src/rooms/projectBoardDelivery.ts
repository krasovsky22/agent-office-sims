/**
 * Gets the project board's snapshot from the feed to every client in a room.
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
 *
 * A player's Refresh is answered here too, to that player alone, once the
 * feed's poll is done: by then the fresh board has gone out on the first path.
 */

import {
  type BoardRefreshResultEvent,
  SERVER_MESSAGE,
  type ProjectBoardSnapshot,
  parseBoardRefreshMessage,
} from "@sim/shared";

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

/** The slice of a Colyseus client a refresh's answer uses. */
export interface RefreshClient {
  send(type: typeof SERVER_MESSAGE.boardRefreshResult, message: BoardRefreshResultEvent): void;
}

/**
 * Has the feed fetch now for a player who pressed Refresh, and tells them when
 * it is done or how long until they may ask again. Any player may; the feed's
 * one allowance is what keeps them all from spending GitHub's rate limit.
 */
export async function answerBoardRefresh(client: RefreshClient, raw: unknown, source: ProjectBoardSource): Promise<void> {
  if (parseBoardRefreshMessage(raw) === undefined || source.refreshNow === undefined) {
    return;
  }
  const retryAfterMs = await source.refreshNow();
  client.send(SERVER_MESSAGE.boardRefreshResult, { retryAfterMs } satisfies BoardRefreshResultEvent);
}
