/**
 * CEO authority, checked end to end against a real room over real sockets.
 *
 * The rules themselves are tested in `@sim/shared`'s `tickets.test.ts`. What
 * only a running room can show is that they hold for a client that skips the
 * UI and sends a command straight down the socket, that the role is assigned
 * and passed on the way the issue says, and that a dropped connection comes
 * back with its role. So these tests boot a Colyseus server and drive it with
 * the same client library the browser uses.
 */

import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import {
  type CeoChangedEvent,
  CLIENT_MESSAGE,
  OFFICE_ROOM_NAME,
  type OfficeState,
  PLAYER_ROLE,
  SERVER_MESSAGE,
  TICKET_ACTION,
  TICKET_PRIORITY,
  TICKET_REJECTION,
  TICKET_STATUS,
  type TicketRejectedEvent,
  isCeo,
} from "@sim/shared";
import { Client, type Room } from "colyseus.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { describeRoleProblems } from "../sim/roles.js";
import { OfficeRoom, type OfficeRoomOptions } from "./OfficeRoom.js";

/** Short, so the test can watch a grace period run out. */
const GRACE_SECONDS = 1;

let server: Server;
let endpoint: string;

beforeAll(async () => {
  server = new Server({ transport: new WebSocketTransport(), greet: false });
  server.define(OFFICE_ROOM_NAME, OfficeRoom, {
    reconnectGraceSeconds: GRACE_SECONDS,
  } satisfies Partial<OfficeRoomOptions>);
  await server.listen(0);
  const address = server.transport.server?.address();
  if (address === null || address === undefined || typeof address === "string") {
    throw new Error("the transport did not bind a TCP port");
  }
  endpoint = `ws://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await server.gracefullyShutdown(false);
});

/** One browser tab: its socket, and what the server has told it. */
interface Tab {
  readonly client: Client;
  room: Room<OfficeState>;
  readonly rejections: TicketRejectedEvent[];
  readonly announcements: CeoChangedEvent[];
}

function listen(tab: Tab, room: Room<OfficeState>): void {
  tab.room = room;
  room.onMessage<TicketRejectedEvent>(SERVER_MESSAGE.ticketRejected, (event) => {
    tab.rejections.push(event);
  });
  room.onMessage<CeoChangedEvent>(SERVER_MESSAGE.ceoChanged, (event) => {
    tab.announcements.push(event);
  });
  // Registered so the client library does not warn about them; unused here.
  room.onMessage(SERVER_MESSAGE.throttled, () => undefined);
}

/** Opens a fresh office as its first, and so CEO, occupant. */
async function openOffice(name: string): Promise<Tab> {
  const client = new Client(endpoint);
  const room = await client.create<OfficeState>(OFFICE_ROOM_NAME, { name });
  const tab: Tab = { client, room, rejections: [], announcements: [] };
  listen(tab, room);
  await settled(() => room.state.occupants?.size === 1);
  return tab;
}

async function joinOffice(office: Tab, name: string): Promise<Tab> {
  const client = new Client(endpoint);
  const room = await client.joinById<OfficeState>(office.room.roomId, { name });
  const tab: Tab = { client, room, rejections: [], announcements: [] };
  listen(tab, room);
  await settled(() => serverRoom(office).state.occupants.has(room.sessionId));
  await settled(() => room.state.occupants?.size === serverRoom(office).state.occupants.size);
  return tab;
}

/** The room instance itself, for reading the authoritative state. */
function serverRoom(tab: Tab): OfficeRoom {
  return matchMaker.getLocalRoomById(tab.room.roomId) as OfficeRoom;
}

function roleOf(tab: Tab, sessionId: string): string | undefined {
  const occupant = serverRoom(tab).state.occupants.get(sessionId);
  return occupant === undefined ? undefined : isCeo(occupant) ? PLAYER_ROLE.ceo : PLAYER_ROLE.exec;
}

/** The board as plain data, for an "unchanged" comparison. */
function boardOf(tab: Tab): unknown {
  return serverRoom(tab).state.tickets.toJSON();
}

/** Polls until `ready` holds; there is no event for "the server got there". */
async function settled(ready: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the room");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Lets the server handle everything already sent, and a patch go out.
 *
 * Every client message is handled in arrival order, so an emote sent after a
 * command comes back only once the command has been dealt with.
 */
async function roundTrip(tab: Tab): Promise<void> {
  let echoed = false;
  const stop = tab.room.onMessage(SERVER_MESSAGE.emote, () => {
    echoed = true;
  });
  tab.room.send(CLIENT_MESSAGE.emote, { emote: "wave" });
  await settled(() => echoed);
  stop();
}

describe("CEO authority over a live socket", () => {
  it("makes the first to join CEO and everyone after an executive", async () => {
    const dana = await openOffice("Dana");
    const milo = await joinOffice(dana, "Milo");

    expect(roleOf(dana, dana.room.sessionId)).toBe(PLAYER_ROLE.ceo);
    expect(roleOf(dana, milo.room.sessionId)).toBe(PLAYER_ROLE.exec);
    // Replicated, so Milo's tab knows who is in charge without asking.
    const seenByMilo = milo.room.state.occupants.get(dana.room.sessionId) as { role?: string };
    expect(seenByMilo.role).toBe(PLAYER_ROLE.ceo);

    await milo.room.leave();
    await dana.room.leave();
  });

  it("refuses every CEO-only command an executive sends directly, and changes nothing", async () => {
    const dana = await openOffice("Dana");
    const milo = await joinOffice(dana, "Milo");

    // Something in review, so approve and reject have a ticket to act on.
    dana.room.send(CLIENT_MESSAGE.ticketAssign, { ticketId: "ticket-1", assigneeId: milo.room.sessionId });
    dana.room.send(CLIENT_MESSAGE.ticketMoveStatus, { ticketId: "ticket-1", status: TICKET_STATUS.in_progress });
    dana.room.send(CLIENT_MESSAGE.ticketMoveStatus, { ticketId: "ticket-1", status: TICKET_STATUS.review });
    await roundTrip(dana);
    expect(dana.rejections).toEqual([]);
    expect(serverRoom(dana).state.tickets.get("ticket-1")?.status).toBe(TICKET_STATUS.review);

    const before = boardOf(dana);
    const ceoOnly: readonly [string, unknown][] = [
      [CLIENT_MESSAGE.ticketCreate, { title: "Milo's idea", body: "" }],
      [CLIENT_MESSAGE.ticketAssign, { ticketId: "ticket-2", assigneeId: milo.room.sessionId }],
      [CLIENT_MESSAGE.ticketAssign, { ticketId: "ticket-1", assigneeId: dana.room.sessionId }],
      [CLIENT_MESSAGE.ticketUnassign, { ticketId: "ticket-1" }],
      [CLIENT_MESSAGE.ticketMoveStatus, { ticketId: "ticket-1", status: TICKET_STATUS.done }],
      [CLIENT_MESSAGE.ticketMoveStatus, { ticketId: "ticket-1", status: TICKET_STATUS.in_progress }],
      [CLIENT_MESSAGE.ticketEdit, { ticketId: "ticket-2", title: "Renamed" }],
      [CLIENT_MESSAGE.ticketSetPriority, { ticketId: "ticket-2", priority: TICKET_PRIORITY.high }],
    ];
    for (const [type, payload] of ceoOnly) {
      milo.room.send(type, payload);
    }
    await roundTrip(milo);

    expect(boardOf(dana)).toEqual(before);
    expect(milo.rejections).toHaveLength(ceoOnly.length);
    for (const event of milo.rejections) {
      expect(event.rejection).toBe(TICKET_REJECTION.forbidden);
    }
    expect(milo.rejections.map((event) => event.action)).toEqual([
      TICKET_ACTION.create,
      TICKET_ACTION.assign,
      TICKET_ACTION.assign,
      TICKET_ACTION.unassign,
      TICKET_ACTION.moveStatus,
      TICKET_ACTION.moveStatus,
      TICKET_ACTION.edit,
      TICKET_ACTION.setPriority,
    ]);
    // Told only to the sender.
    expect(dana.rejections).toEqual([]);

    await milo.room.leave();
    await dana.room.leave();
  });

  it("lets an executive comment, and the CEO run the board", async () => {
    const dana = await openOffice("Dana");
    const milo = await joinOffice(dana, "Milo");

    milo.room.send(CLIENT_MESSAGE.ticketComment, { ticketId: "ticket-1", text: "Measure first." });
    dana.room.send(CLIENT_MESSAGE.ticketSetPriority, { ticketId: "ticket-1", priority: TICKET_PRIORITY.high });
    dana.room.send(CLIENT_MESSAGE.ticketCreate, { title: "Dana's call", body: "" });
    await roundTrip(milo);
    await roundTrip(dana);

    expect(milo.rejections).toEqual([]);
    expect(dana.rejections).toEqual([]);
    const ticket = serverRoom(dana).state.tickets.get("ticket-1");
    expect(ticket?.priority).toBe(TICKET_PRIORITY.high);
    expect(ticket?.comments.map((comment) => comment.toJSON())).toEqual([
      expect.objectContaining({ authorId: milo.room.sessionId, text: "Measure first." }),
    ]);
    expect([...serverRoom(dana).state.tickets.values()].map((t) => t.title)).toContain("Dana's call");

    await milo.room.leave();
    await dana.room.leave();
  });

  it("stops judging a player as CEO the moment the role passes on", async () => {
    const dana = await openOffice("Dana");
    const milo = await joinOffice(dana, "Milo");

    await dana.room.leave();
    await settled(() => roleOf(milo, milo.room.sessionId) === PLAYER_ROLE.ceo);

    milo.room.send(CLIENT_MESSAGE.ticketCreate, { title: "Milo runs it now", body: "" });
    await roundTrip(milo);
    expect(milo.rejections).toEqual([]);

    await milo.room.leave();
  });
});

describe("CEO succession", () => {
  it("promotes exactly the longest-connected player, announces it, and never shows two or none", async () => {
    const dana = await openOffice("Dana");
    const milo = await joinOffice(dana, "Milo");
    const ines = await joinOffice(dana, "Ines");

    // Ines watches every patch she decodes for a moment with the wrong number
    // of CEOs in it.
    const ceoCounts: number[] = [];
    ines.room.onStateChange((state) => {
      ceoCounts.push([...state.occupants.values()].filter(isCeo).length);
    });

    await dana.room.leave();
    await settled(() => ines.announcements.length === 1 && milo.announcements.length === 1);

    expect(roleOf(milo, milo.room.sessionId)).toBe(PLAYER_ROLE.ceo);
    expect(roleOf(milo, ines.room.sessionId)).toBe(PLAYER_ROLE.exec);
    expect(describeRoleProblems(serverRoom(milo).state.occupants)).toEqual([]);
    expect(ines.announcements).toEqual([
      { ceoId: milo.room.sessionId, previousCeoId: dana.room.sessionId },
    ]);
    await settled(() => ceoCounts.length > 0);
    expect(ceoCounts.every((count) => count === 1)).toBe(true);

    // An executive leaving changes nothing and announces nothing.
    await ines.room.leave();
    await roundTrip(milo);
    expect(roleOf(milo, milo.room.sessionId)).toBe(PLAYER_ROLE.ceo);
    expect(milo.announcements).toHaveLength(1);

    await milo.room.leave();
  });
});

describe("the role across a reconnect", () => {
  it("holds a dropped CEO's role and hands it back on reconnection", async () => {
    const dana = await openOffice("Dana");
    const milo = await joinOffice(dana, "Milo");
    const sessionId = dana.room.sessionId;
    const token = dana.room.reconnectionToken;

    // A drop, not a leave: the socket closes without the client saying so.
    await dana.room.leave(false);
    await roundTrip(milo);
    expect(roleOf(milo, sessionId)).toBe(PLAYER_ROLE.ceo);
    expect(roleOf(milo, milo.room.sessionId)).toBe(PLAYER_ROLE.exec);

    // A newcomer in the window does not become a second CEO.
    const ines = await joinOffice(milo, "Ines");
    expect(roleOf(milo, ines.room.sessionId)).toBe(PLAYER_ROLE.exec);

    listen(dana, await dana.client.reconnect<OfficeState>(token));
    expect(dana.room.sessionId).toBe(sessionId);
    await roundTrip(dana);
    expect(roleOf(milo, sessionId)).toBe(PLAYER_ROLE.ceo);
    expect(describeRoleProblems(serverRoom(milo).state.occupants)).toEqual([]);
    expect(milo.announcements).toEqual([]);

    // And still has the CEO's authority.
    dana.room.send(CLIENT_MESSAGE.ticketCreate, { title: "Back again", body: "" });
    await roundTrip(dana);
    expect(dana.rejections).toEqual([]);

    await ines.room.leave();
    await milo.room.leave();
    await dana.room.leave();
  });

  it("passes the role on once the grace period runs out", async () => {
    const dana = await openOffice("Dana");
    const milo = await joinOffice(dana, "Milo");
    const sessionId = dana.room.sessionId;

    await dana.room.leave(false);
    await settled(
      () => roleOf(milo, milo.room.sessionId) === PLAYER_ROLE.ceo,
      GRACE_SECONDS * 1000 + 2000,
    );
    expect(serverRoom(milo).state.occupants.has(sessionId)).toBe(false);
    await settled(() => milo.announcements.length > 0);
    expect(milo.announcements).toEqual([{ ceoId: milo.room.sessionId, previousCeoId: sessionId }]);

    await milo.room.leave();
  });
});
