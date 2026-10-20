/**
 * The one office, against a real server: a full office turns the next player
 * away, and no client can open a second one.
 */

import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { OFFICE_CAPACITY, OFFICE_ROOM_NAME, type OfficeState } from "@sim/shared";
import { Client, ErrorCode, type Room } from "colyseus.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { officeRoom } from "./OfficeRoom.js";
import { openOnlyOffice } from "./onlyOffice.js";

let server: Server;
let endpoint: string;

beforeAll(async () => {
  server = new Server({ transport: new WebSocketTransport(), greet: false });
  server.define(OFFICE_ROOM_NAME, officeRoom({ reconnectGraceSeconds: 0 }));
  await server.listen(0);
  const address = server.transport.server?.address();
  if (address === null || address === undefined || typeof address === "string") {
    throw new Error("the transport did not bind a TCP port");
  }
  endpoint = `ws://127.0.0.1:${address.port}`;
  await openOnlyOffice();
});

afterAll(async () => {
  await server.gracefullyShutdown(false);
});

async function officeCount(): Promise<number> {
  return (await matchMaker.query({ name: OFFICE_ROOM_NAME })).length;
}

describe("the only office", () => {
  it("is open before anyone joins, and a client cannot open another", async () => {
    expect(await officeCount()).toBe(1);
    await expect(new Client(endpoint).create(OFFICE_ROOM_NAME, { name: "Dana" })).rejects.toThrow();
    await expect(new Client(endpoint).joinOrCreate(OFFICE_ROOM_NAME, { name: "Dana" })).rejects.toThrow();
    expect(await officeCount()).toBe(1);
  });

  it("turns the player after a full office away instead of opening a second", async () => {
    const rooms: Room<OfficeState>[] = [];
    for (let seat = 0; seat < OFFICE_CAPACITY; seat += 1) {
      rooms.push(await new Client(endpoint).join<OfficeState>(OFFICE_ROOM_NAME, { name: `P${seat + 1}` }));
    }
    expect(new Set(rooms.map((room) => room.roomId)).size).toBe(1);

    const turnedAway = new Client(endpoint).join(OFFICE_ROOM_NAME, { name: "Late" });
    // The code the client reads as "the office is full".
    await expect(turnedAway).rejects.toMatchObject({ code: ErrorCode.MATCHMAKE_INVALID_CRITERIA });
    expect(await officeCount()).toBe(1);

    await Promise.all(rooms.map((room) => room.leave()));
  });
});
