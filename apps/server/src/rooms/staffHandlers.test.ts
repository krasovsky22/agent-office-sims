/**
 * Hiring, firing and quitting, end to end against a real room over real sockets.
 *
 * The rules are tested in `@sim/shared`'s `staffing.test.ts`. What only a
 * running room can show is that a command sent straight down the socket is
 * judged by the server's idea of who is CEO, that every tab hears about a
 * change with enough to say why, and that the tick turns a long enough run of
 * bad days into a departure.
 */

import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import {
  CLIENT_MESSAGE,
  DEFAULT_AGENT_COUNT,
  HIRING_CANDIDATES,
  MORALE_LOSS_PER_FIRING,
  OFFICE_LAYOUT,
  OFFICE_ROOM_NAME,
  type OfficeState,
  QUIT_AFTER_LOW_MORALE_DAYS,
  QUIT_REASON,
  SERVER_MESSAGE,
  STAFF_ACTION,
  STAFF_CHANGE,
  STAFF_REJECTION,
  STARTING_CASH,
  STARTING_MORALE,
  type StaffChangedEvent,
  type StaffRejectedEvent,
  TICKET_STATUS,
  isAgentEmployee,
} from "@sim/shared";
import { Client, type Room } from "colyseus.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OfficeRoom, type OfficeRoomOptions } from "./OfficeRoom.js";

let server: Server;
let endpoint: string;

beforeAll(async () => {
  server = new Server({ transport: new WebSocketTransport(), greet: false });
  server.define(OFFICE_ROOM_NAME, OfficeRoom, {
    agentCount: DEFAULT_AGENT_COUNT,
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

interface Tab {
  readonly room: Room<OfficeState>;
  readonly rejections: StaffRejectedEvent[];
  readonly changes: StaffChangedEvent[];
}

function listen(room: Room<OfficeState>): Tab {
  const tab: Tab = { room, rejections: [], changes: [] };
  room.onMessage<StaffRejectedEvent>(SERVER_MESSAGE.staffRejected, (event) => {
    tab.rejections.push(event);
  });
  room.onMessage<StaffChangedEvent>(SERVER_MESSAGE.staffChanged, (event) => {
    tab.changes.push(event);
  });
  room.onMessage(SERVER_MESSAGE.ceoChanged, () => undefined);
  room.onMessage(SERVER_MESSAGE.ticketRejected, () => undefined);
  return tab;
}

async function openOffice(): Promise<{ dana: Tab; milo: Tab }> {
  const dana = listen(await new Client(endpoint).create<OfficeState>(OFFICE_ROOM_NAME, { name: "Dana" }));
  const milo = listen(
    await new Client(endpoint).joinById<OfficeState>(dana.room.roomId, { name: "Milo" }),
  );
  await settled(() => serverRoom(dana).state.occupants.has(milo.room.sessionId));
  return { dana, milo };
}

function serverRoom(tab: Tab): OfficeRoom {
  return matchMaker.getLocalRoomById(tab.room.roomId) as OfficeRoom;
}

function agentIds(tab: Tab): string[] {
  return [...serverRoom(tab).state.occupants.values()]
    .filter(isAgentEmployee)
    .map((agent) => agent.id);
}

async function settled(ready: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the room");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Lets the server handle everything this tab has already sent. */
async function roundTrip(tab: Tab): Promise<void> {
  let echoed = false;
  const stop = tab.room.onMessage(SERVER_MESSAGE.emote, () => {
    echoed = true;
  });
  tab.room.send(CLIENT_MESSAGE.emote, { emote: "wave" });
  await settled(() => echoed);
  stop();
}

async function leave(...tabs: Tab[]): Promise<void> {
  for (const tab of tabs) {
    await tab.room.leave();
  }
}

const CANDIDATE = HIRING_CANDIDATES[0];
if (CANDIDATE === undefined) {
  throw new Error("the candidate list is empty");
}

describe("staffing over a live socket", () => {
  it("hires for the CEO, at a free desk, and tells every tab", async () => {
    const { dana, milo } = await openOffice();
    dana.room.send(CLIENT_MESSAGE.staffHire, { candidateId: CANDIDATE.id });
    await settled(() => milo.changes.length === 1);

    const [event] = milo.changes;
    expect(event).toMatchObject({
      change: STAFF_CHANGE.hired,
      jobTitle: CANDIDATE.jobTitle,
      salary: CANDIDATE.salary,
    });
    const hired = event === undefined ? undefined : serverRoom(dana).state.occupants.get(event.agentId);
    expect(hired !== undefined && isAgentEmployee(hired)).toBe(true);
    if (hired !== undefined && isAgentEmployee(hired)) {
      expect(hired.deskId).toBe(OFFICE_LAYOUT.agentDesks[DEFAULT_AGENT_COUNT]);
    }
    expect(serverRoom(dana).state.company.cash).toBe(STARTING_CASH);
    // Replicated, so Milo's tab has the new agent to draw.
    await settled(() => event !== undefined && milo.room.state.occupants.has(event.agentId));

    await leave(milo, dana);
  });

  it("refuses an executive's hire and fire, to them alone", async () => {
    const { dana, milo } = await openOffice();
    milo.room.send(CLIENT_MESSAGE.staffHire, { candidateId: CANDIDATE.id });
    milo.room.send(CLIENT_MESSAGE.staffFire, { agentId: "agent-1" });
    await roundTrip(milo);

    expect(milo.rejections).toEqual([
      { action: STAFF_ACTION.hire, rejection: STAFF_REJECTION.forbidden },
      { action: STAFF_ACTION.fire, rejection: STAFF_REJECTION.forbidden },
    ]);
    expect(dana.rejections).toEqual([]);
    expect(agentIds(dana)).toHaveLength(DEFAULT_AGENT_COUNT);

    await leave(milo, dana);
  });

  it("fires an agent mid-ticket and leaves the ticket in the backlog for someone else", async () => {
    const { dana, milo } = await openOffice();
    dana.room.send(CLIENT_MESSAGE.ticketAssign, { ticketId: "ticket-1", assigneeId: "agent-1" });
    dana.room.send(CLIENT_MESSAGE.ticketMoveStatus, {
      ticketId: "ticket-1",
      status: TICKET_STATUS.in_progress,
    });
    dana.room.send(CLIENT_MESSAGE.staffFire, { agentId: "agent-1" });
    await settled(() => milo.changes.length === 1);

    expect(milo.changes[0]).toMatchObject({
      change: STAFF_CHANGE.fired,
      agentId: "agent-1",
      moraleLost: MORALE_LOSS_PER_FIRING,
      releasedTickets: 1,
    });
    const state = serverRoom(dana).state;
    expect(state.occupants.has("agent-1")).toBe(false);
    expect(state.company.morale).toBe(STARTING_MORALE - MORALE_LOSS_PER_FIRING);
    const ticket = state.tickets.get("ticket-1");
    expect(ticket?.status).toBe(TICKET_STATUS.backlog);
    expect(ticket?.assigneeId).toBe("");

    // Recoverable: the CEO can hand it straight to someone still here.
    dana.room.send(CLIENT_MESSAGE.ticketAssign, { ticketId: "ticket-1", assigneeId: "agent-2" });
    await roundTrip(dana);
    expect(state.tickets.get("ticket-1")?.assigneeId).toBe("agent-2");

    await leave(milo, dana);
  });

  it("refuses a hire past the last agent desk, with the reason", async () => {
    const { dana, milo } = await openOffice();
    const free = OFFICE_LAYOUT.agentDesks.length - DEFAULT_AGENT_COUNT;
    for (let i = 0; i <= free; i += 1) {
      dana.room.send(CLIENT_MESSAGE.staffHire, { candidateId: CANDIDATE.id });
    }
    await roundTrip(dana);

    expect(agentIds(dana)).toHaveLength(OFFICE_LAYOUT.agentDesks.length);
    expect(dana.rejections).toEqual([
      { action: STAFF_ACTION.hire, rejection: STAFF_REJECTION.noFreeDesk },
    ]);

    await leave(milo, dana);
  });

  it("loses an agent once morale has stayed low long enough, and says why", async () => {
    const { dana, milo } = await openOffice();
    const before = agentIds(dana);
    // As the day's close leaves it after a long enough run of bad days.
    serverRoom(dana).state.company.lowMoraleDays = QUIT_AFTER_LOW_MORALE_DAYS;
    await settled(() => milo.changes.length === 1);

    expect(milo.changes[0]).toMatchObject({
      change: STAFF_CHANGE.quit,
      agentId: before[before.length - 1],
      reason: QUIT_REASON,
    });
    expect(agentIds(dana)).toEqual(before.slice(0, -1));
    expect(serverRoom(dana).state.company.lowMoraleDays).toBe(0);

    await leave(milo, dana);
  });
});
