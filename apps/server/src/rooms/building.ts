/**
 * The building: its floors, each one repository's office in a room of its
 * own, and what the lift needs to know of them.
 *
 * Every floor's room is opened at boot and kept open (see `onlyOffice.ts` and
 * `OfficeRoom`), so the building holds each one's listing for as long as the
 * server runs: a ride is a seat reserved on the listing, and a floor's
 * headcount is read off its room's state.
 */

import { type IRoomCache, matchMaker } from "@colyseus/core";
import { type LiftFloor, type LiftSeatReservation, OCCUPANT_KIND, floorRoomName } from "@sim/shared";

import type { BuildingLifts } from "./liftHandlers.js";
import type { OfficeRoom } from "./OfficeRoom.js";
import { openOnlyOffice } from "./onlyOffice.js";

/** One floor: its number, from 1 at the street, and whose office it is. */
export interface Floor {
  readonly floor: number;
  /** `owner/name`. */
  readonly repository: string;
}

export class Building implements BuildingLifts {
  private readonly listings = new Map<number, IRoomCache>();

  public constructor(private readonly plan: readonly Floor[]) {}

  /** Opens every floor's room and keeps clients from opening others; call once the server is listening. */
  public async open(): Promise<void> {
    const listings = await openOnlyOffice(this.plan.map(({ floor }) => floorRoomName(floor)));
    this.plan.forEach(({ floor }, index) => {
      const listing = listings[index];
      if (listing !== undefined) {
        this.listings.set(floor, listing);
      }
    });
  }

  public floors(): readonly LiftFloor[] {
    return this.plan.map(({ floor, repository }) => ({ floor, repository, people: this.people(floor) }));
  }

  public async reserve(floor: number, name: string): Promise<LiftSeatReservation | undefined> {
    const listing = this.listings.get(floor);
    if (listing === undefined) {
      return undefined;
    }
    try {
      // Join options, as a client's would be: the rider keeps their name, if the floor has nobody by it.
      const seat = await matchMaker.reserveSeatFor(listing, { name });
      return { sessionId: seat.sessionId, room: { name: seat.room.name, roomId: seat.room.roomId, processId: seat.room.processId } };
    } catch {
      // Full: Colyseus counts kept seats against the floor's places.
      return undefined;
    }
  }

  private people(floor: number): number {
    const listing = this.listings.get(floor);
    const room = listing === undefined ? undefined : (matchMaker.getLocalRoomById(listing.roomId) as OfficeRoom | undefined);
    let count = 0;
    for (const occupant of room?.state.occupants.values() ?? []) {
      if (occupant.kind === OCCUPANT_KIND.human) {
        count += 1;
      }
    }
    return count;
  }
}
