/**
 * The lift between two floors, against a real server: a player at the lift on
 * one floor's room is given a seat on the other's, takes it with the same
 * client library the browser uses, and leaves the floor they rode from.
 *
 * Players are put at the lift by writing their position into the room, as if
 * they had walked there: walking is the movement tests' business.
 */

import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import {
  CLIENT_MESSAGE,
  INTERACTION_KIND,
  LIFT_REJECTION,
  LOBBY_ROOM_ID,
  type LiftFloorsEvent,
  type LiftRejectedEvent,
  type LiftSeatEvent,
  type OfficeState,
  SERVER_MESSAGE,
  UPPER_FLOOR_LAYOUT,
  floorLayout,
  floorRoomName,
  interactables,
  isCeo,
  roomAt,
} from "@sim/shared";
import { Client, type Room, type SeatReservation } from "colyseus.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createSimClock } from "../sim/clock.js";
import { Building } from "./building.js";
import { type OfficeRoom, officeRoom } from "./OfficeRoom.js";

const building = new Building([
  { floor: 1, repository: "acme/office" },
  { floor: 2, repository: "acme/site" },
]);

let server: Server;
let endpoint: string;

beforeAll(async () => {
  server = new Server({ transport: new WebSocketTransport(), greet: false });
  const clock = createSimClock(Date.now());
  for (const floor of [1, 2]) {
    server.define(floorRoomName(floor), officeRoom({ floor: { floor, floors: 2 }, lifts: building, clock, reconnectGraceSeconds: 0 }));
  }
  await server.listen(0);
  const address = server.transport.server?.address();
  if (address === null || address === undefined || typeof address === "string") {
    throw new Error("the transport did not bind a TCP port");
  }
  endpoint = `ws://127.0.0.1:${address.port}`;
  await building.open();
});

afterAll(async () => {
  await server.gracefullyShutdown(false);
});

/** One tab: its client, its room, and every lift answer it was sent. */
interface Tab {
  readonly client: Client;
  room: Room<OfficeState>;
  readonly floors: LiftFloorsEvent[];
  readonly seats: LiftSeatEvent[];
  readonly rejections: LiftRejectedEvent[];
}

function listen(tab: Tab, room: Room<OfficeState>): void {
  tab.room = room;
  room.onMessage<LiftFloorsEvent>(SERVER_MESSAGE.liftFloors, (event) => tab.floors.push(event));
  room.onMessage<LiftSeatEvent>(SERVER_MESSAGE.liftSeat, (event) => tab.seats.push(event));
  room.onMessage<LiftRejectedEvent>(SERVER_MESSAGE.liftRejected, (event) => tab.rejections.push(event));
  // Registered so the client library does not warn about them; unused here.
  for (const type of [SERVER_MESSAGE.managerHistory, SERVER_MESSAGE.emote, SERVER_MESSAGE.chat, SERVER_MESSAGE.ceoChanged]) {
    room.onMessage(type, () => undefined);
  }
}

async function settled(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the office to settle");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function serverRoom(room: Room<OfficeState>): OfficeRoom {
  return matchMaker.getLocalRoomById(room.roomId) as OfficeRoom;
}

async function arrive(name: string, floor = 1): Promise<Tab> {
  const client = new Client(endpoint);
  const room = await client.join<OfficeState>(floorRoomName(floor), { name });
  const tab: Tab = { client, room, floors: [], seats: [], rejections: [] };
  listen(tab, room);
  await settled(() => room.state.occupants?.has(room.sessionId) === true);
  return tab;
}

/** Stands the tab's player at the first lift's call on whichever floor they are. */
function standAtLift(tab: Tab): void {
  const office = serverRoom(tab.room);
  const call = interactables(floorLayout(office.state.floor, office.state.floors)).find((spec) => spec.kind === INTERACTION_KIND.lift);
  const occupant = office.state.occupants.get(tab.room.sessionId);
  if (call === undefined || occupant === undefined) {
    throw new Error("no lift to stand at");
  }
  occupant.x = call.anchor.x;
  occupant.z = call.anchor.z;
}

/** Rides the lift as the client does: takes the seat it was given, then leaves the floor it rode from. */
async function ride(tab: Tab, floor: number): Promise<void> {
  const before = tab.seats.length;
  tab.room.send(CLIENT_MESSAGE.liftRide, { floor });
  await settled(() => tab.seats.length > before);
  const seat = tab.seats.at(-1);
  if (seat === undefined) {
    throw new Error("no seat");
  }
  // As the browser's connection does: the counts of a listing are not the lift's to pass on.
  const reservation: SeatReservation = { sessionId: seat.reservation.sessionId, room: { ...seat.reservation.room, clients: 0, maxClients: 0 } };
  const next = await tab.client.consumeSeatReservation<OfficeState>(reservation);
  const left = tab.room;
  listen(tab, next);
  await left.leave();
  await settled(() => next.state.occupants?.has(next.sessionId) === true);
}

describe("the lift", () => {
  it("lists every floor with who is on it, but only to someone standing at a lift", async () => {
    const dana = await arrive("Dana");
    dana.room.send(CLIENT_MESSAGE.liftFloors, {});
    await settled(() => dana.rejections.length === 1);
    expect(dana.rejections[0]).toEqual({ rejection: LIFT_REJECTION.outOfRange });

    standAtLift(dana);
    dana.room.send(CLIENT_MESSAGE.liftFloors, {});
    await settled(() => dana.floors.length === 1);
    expect(dana.floors[0]).toEqual({
      floors: [
        { floor: 1, repository: "acme/office", people: 1 },
        { floor: 2, repository: "acme/site", people: 0 },
      ],
    });
    await dana.room.leave();
  });

  it("takes a rider to the other floor's room, under their name, stepping out of the lift there; each floor keeps its own CEO", async () => {
    const dana = await arrive("Dana");
    const milo = await arrive("Milo");
    const ground = serverRoom(dana.room);
    expect(ground.state.floor).toBe(1);
    expect(isCeo(ground.state.occupants.get(dana.room.sessionId)!)).toBe(true);

    standAtLift(dana);
    const riderId = dana.room.sessionId;
    await ride(dana, 2);

    const upstairs = serverRoom(dana.room);
    expect(upstairs).not.toBe(ground);
    expect(upstairs.state.floor).toBe(2);
    expect(dana.room.state.floor).toBe(2);
    const rider = upstairs.state.occupants.get(dana.room.sessionId);
    expect(rider?.name).toBe("Dana");
    expect(rider === undefined ? false : isCeo(rider)).toBe(true);
    expect(roomAt(UPPER_FLOOR_LAYOUT, rider ?? { x: 0, z: 0 })?.id).toBe(LOBBY_ROOM_ID);

    // Gone from the floor below, whose CEO role passed to the player still there.
    await settled(() => !ground.state.occupants.has(riderId));
    const stayed = ground.state.occupants.get(milo.room.sessionId);
    expect(stayed === undefined ? false : isCeo(stayed)).toBe(true);
    expect(building.floors()).toEqual([
      { floor: 1, repository: "acme/office", people: 1 },
      { floor: 2, repository: "acme/site", people: 1 },
    ]);

    // And back down again, from the upper floor's own lift.
    standAtLift(dana);
    await ride(dana, 1);
    expect(serverRoom(dana.room)).toBe(ground);
    await settled(() => building.floors()[1]?.people === 0);
    // Emptied, the upper floor stays open, as the ground floor does: its work lives in it.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(matchMaker.getLocalRoomById(upstairs.roomId)).toBe(upstairs);

    await dana.room.leave();
    await milo.room.leave();
  });

  it("refuses a ride to the floor the rider is on, to a floor the building does not have, and a second ride before the first is taken", async () => {
    const dana = await arrive("Dana");
    standAtLift(dana);
    dana.room.send(CLIENT_MESSAGE.liftRide, { floor: 1 });
    dana.room.send(CLIENT_MESSAGE.liftRide, { floor: 3 });
    await settled(() => dana.rejections.length === 2);
    expect(dana.rejections).toEqual([{ rejection: LIFT_REJECTION.sameFloor }, { rejection: LIFT_REJECTION.unknownFloor }]);

    dana.room.send(CLIENT_MESSAGE.liftRide, { floor: 2 });
    await settled(() => dana.seats.length === 1);
    dana.room.send(CLIENT_MESSAGE.liftRide, { floor: 2 });
    await settled(() => dana.rejections.length === 3);
    expect(dana.rejections[2]).toEqual({ rejection: LIFT_REJECTION.riding });
    await dana.room.leave();
  });

  it("turns a rider away from a full floor, and they stay where they are", async () => {
    const dana = await arrive("Dana");
    const milo = await arrive("Milo", 2);
    const upstairs = serverRoom(milo.room);
    const places = upstairs.maxClients;
    upstairs.maxClients = upstairs.clients.length;
    try {
      standAtLift(dana);
      dana.room.send(CLIENT_MESSAGE.liftRide, { floor: 2 });
      await settled(() => dana.rejections.length === 1);
      expect(dana.rejections[0]).toEqual({ rejection: LIFT_REJECTION.full });
      expect(serverRoom(dana.room).state.occupants.has(dana.room.sessionId)).toBe(true);
    } finally {
      upstairs.maxClients = places;
    }
    await dana.room.leave();
    await milo.room.leave();
  });
});
