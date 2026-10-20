/**
 * One office per server, opened at boot, that clients can only join.
 *
 * Colyseus would otherwise open a second office for whoever finds the first
 * full, and make its only player the CEO of an empty floor. Both offices
 * share the runner link, so the second one's once-a-second check would stop
 * the first one's agents. A full office turns the next player away instead.
 */

import { matchMaker } from "@colyseus/core";
import { OFFICE_ROOM_NAME } from "@sim/shared";

/**
 * Opens the office and takes `create` and `joinOrCreate` away from clients.
 *
 * Call once the server is listening. The office it opens is the first, so it
 * stays open when it empties (see `OfficeRoom`), and a join it cannot seat
 * fails with "no rooms found" rather than opening another.
 */
export async function openOnlyOffice(): Promise<void> {
  matchMaker.controller.exposedMethods = ["join", "joinById", "reconnect"];
  await matchMaker.createRoom(OFFICE_ROOM_NAME, {});
}
