/**
 * One office per floor, opened at boot, that clients can only join.
 *
 * Colyseus would otherwise open a second office for whoever finds the first
 * full, and make its only player the CEO of an empty floor. Both offices
 * share the runner link, so the second one's once-a-second check would stop
 * the first one's agents. A full office turns the next player away instead.
 */

import { type IRoomCache, matchMaker } from "@colyseus/core";
import { OFFICE_ROOM_NAME } from "@sim/shared";

/**
 * Opens an office for each room name, the ground floor's alone by default,
 * and takes `create` and `joinOrCreate` away from clients.
 *
 * Call once the server is listening. Each office it opens is its floor's
 * first, so it stays open when it empties (see `OfficeRoom`), and a join it
 * cannot seat fails with "no rooms found" rather than opening another. A
 * seat the lift reserves is taken without the matchmaker, so riding needs
 * none of what is taken away.
 *
 * @returns each office's listing, in the order of the names.
 */
export async function openOnlyOffice(roomNames: readonly string[] = [OFFICE_ROOM_NAME]): Promise<IRoomCache[]> {
  matchMaker.controller.exposedMethods = ["join", "joinById", "reconnect"];
  const listings: IRoomCache[] = [];
  for (const name of roomNames) {
    listings.push(await matchMaker.createRoom(name, {}));
  }
  return listings;
}
