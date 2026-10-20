/**
 * The AI manager end to end, against a real room over real sockets.
 *
 * Its parts are tested in `manager/`. What only a running room can show is
 * the issue's acceptance: the manager is in the office at its own desk; in
 * mock mode a question about a GitHub issue or the agents is answered from live
 * state with no network call; an assignment it cannot make is refused with the
 * reason; an executive's instruction is refused with a reason; and the room
 * keeps ticking at full rate while the manager thinks.
 */

import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import {
  CLIENT_MESSAGE,
  MANAGER_ENTRY_KIND,
  MANAGER_OCCUPANT_ID,
  MANAGER_REJECTION,
  MANAGER_STATUS,
  type ManagerEntry,
  type ManagerHistoryEvent,
  type ManagerRejectedEvent,
  OCCUPANT_KIND,
  OFFICE_LAYOUT,
  OFFICE_ROOM_NAME,
  type OfficeState,
  SERVER_MESSAGE,
  EMPTY_BOARD_LISTS,
  type ProjectBoardSnapshot,
  TICK_RATE_HZ,
  isAiManager,
  managerSeat,
} from "@sim/shared";
import { Client, type Room } from "colyseus.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createManagerAdvisor } from "../manager/advisor.js";
import { createRulePlanner } from "../manager/fromConfig.js";
import { OfficeRoom, officeRoom } from "./OfficeRoom.js";

/** The project board the manager answers about and hands out from. */
const BOARD: ProjectBoardSnapshot = {
  ...EMPTY_BOARD_LISTS,
  open: [{ number: 1, title: "Fix the login redirect loop", body: "", labels: [], assignees: [], pullRequests: [], closedAt: null }],
  counts: { open: 1, inProgress: 0, pullRequests: 0 },
  repository: "acme/office",
  updatedAt: 1,
  stale: false,
};

/** An office whose manager thinks forever, to watch the room tick meanwhile. */
const PONDERING_ROOM = "office-pondering-manager";

let server: Server;
let endpoint: string;
const pondering: AbortSignal[] = [];

beforeAll(async () => {
  server = new Server({ transport: new WebSocketTransport(), greet: false });
  server.define(OFFICE_ROOM_NAME, officeRoom({
    manager: createManagerAdvisor({ planner: createRulePlanner(0), mode: "rules" }),
    projectBoard: { current: () => BOARD, subscribe: () => () => undefined },
  }));
  server.define(PONDERING_ROOM, officeRoom({
    manager: createManagerAdvisor({
      mode: "model",
      planner: (_request, signal) => {
        pondering.push(signal);
        return new Promise(() => undefined);
      },
    }),
  }));
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
  readonly history: ManagerEntry[][];
  readonly entries: ManagerEntry[];
  readonly rejections: ManagerRejectedEvent[];
}

function listen(room: Room<OfficeState>): Tab {
  const tab: Tab = { room, history: [], entries: [], rejections: [] };
  room.onMessage<ManagerHistoryEvent>(SERVER_MESSAGE.managerHistory, (event) => {
    tab.history.push([...event.entries]);
  });
  room.onMessage<ManagerEntry>(SERVER_MESSAGE.managerEntry, (entry) => {
    tab.entries.push(entry);
  });
  room.onMessage<ManagerRejectedEvent>(SERVER_MESSAGE.managerRejected, (event) => {
    tab.rejections.push(event);
  });
  room.onMessage(SERVER_MESSAGE.throttled, () => undefined);
  room.onMessage(SERVER_MESSAGE.ceoChanged, () => undefined);
  room.onMessage(SERVER_MESSAGE.projectBoard, () => undefined);
  return tab;
}

async function openOffice(roomName = OFFICE_ROOM_NAME): Promise<{ dana: Tab; milo: Tab }> {
  const dana = listen(await new Client(endpoint).create<OfficeState>(roomName, { name: "Dana" }));
  const milo = listen(await new Client(endpoint).joinById<OfficeState>(dana.room.roomId, { name: "Milo" }));
  await settled(() => serverRoom(dana).state.occupants.has(milo.room.sessionId));
  await settled(() => dana.history.length === 1 && milo.history.length === 1);
  return { dana, milo };
}

function serverRoom(tab: Tab): OfficeRoom {
  return matchMaker.getLocalRoomById(tab.room.roomId) as OfficeRoom;
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

function say(tab: Tab, text: string): void {
  tab.room.send(CLIENT_MESSAGE.managerSay, { text });
}

function replies(tab: Tab): ManagerEntry[] {
  return tab.entries.filter((entry) => entry.kind === MANAGER_ENTRY_KIND.reply);
}

describe("the AI manager in a live room", () => {
  it("sits at its own desk, seen by every tab, its chair taken", async () => {
    const { dana, milo } = await openOffice();
    const manager = serverRoom(dana).state.occupants.get(MANAGER_OCCUPANT_ID);
    expect(manager !== undefined && isAiManager(manager)).toBe(true);
    expect(manager?.interactableId).toBe(managerSeat(OFFICE_LAYOUT)?.id);
    expect(milo.room.state.occupants.get(MANAGER_OCCUPANT_ID)?.kind).toBe(OCCUPANT_KIND.manager);

    await milo.room.leave();
    await dana.room.leave();
  });

  it("answers the CEO's questions from live state, in every tab, and hands a joiner the conversation", async () => {
    const { dana, milo } = await openOffice();
    say(dana, "what's the status of #1?");
    await settled(() => replies(milo).length === 1);
    expect(milo.entries.map((entry) => [entry.kind, entry.authorName, entry.text])).toEqual([
      [MANAGER_ENTRY_KIND.instruction, "Dana", "what's the status of #1?"],
      [MANAGER_ENTRY_KIND.reply, "AI Manager", "#1 “Fix the login redirect loop” is open. Nobody in the office is on it yet."],
    ]);

    say(dana, "what is everyone working on?");
    await settled(() => replies(dana).length === 2);
    expect(replies(dana)[1]?.text).toBe("Nobody is on the floor right now: there are no agents to report on.");

    const late = listen(await new Client(endpoint).joinById<OfficeState>(dana.room.roomId, { name: "Ivy" }));
    await settled(() => late.history.length === 1);
    expect(late.history[0]?.map((entry) => entry.text)).toEqual(dana.entries.map((entry) => entry.text));

    await late.room.leave();
    await milo.room.leave();
    await dana.room.leave();
  });

  it("refuses an executive's instruction with the reason, and nobody hears it", async () => {
    const { dana, milo } = await openOffice();
    say(milo, "put someone on #1");
    await settled(() => milo.rejections.length === 1);
    expect(milo.rejections).toEqual([{ rejection: MANAGER_REJECTION.forbidden }]);
    expect(dana.entries).toEqual([]);
    expect(serverRoom(dana).state.work.size).toBe(0);

    await milo.room.leave();
    await dana.room.leave();
  });

  it("answers about the project board, and says why it cannot hand an issue out with no agent to take it", async () => {
    const { dana, milo } = await openOffice();
    say(dana, "what's open?");
    await settled(() => replies(dana).length === 1);
    expect(replies(dana)[0]?.text).toContain("Open: #1 “Fix the login redirect loop”");

    say(dana, "put someone on #1");
    await settled(() => replies(dana).length === 2);
    expect(replies(dana)[1]?.text).toContain(
      "✗ #1 “Fix the login redirect loop”: there are no coding agents on the floor.",
    );
    expect(serverRoom(dana).state.work.size).toBe(0);

    await milo.room.leave();
    await dana.room.leave();
  });

  it("keeps the room ticking at full rate while it thinks, and stops thinking when the room closes", async () => {
    const { dana, milo } = await openOffice(PONDERING_ROOM);
    const room = serverRoom(dana);
    say(dana, "what is everyone working on?");
    await settled(() => pondering.length === 1);
    const manager = room.state.occupants.get(MANAGER_OCCUPANT_ID);
    expect(manager !== undefined && isAiManager(manager) && manager.status === MANAGER_STATUS.thinking).toBe(true);

    const before = room.ticks;
    await new Promise((resolve) => setTimeout(resolve, 500));
    // Half a second at the tick rate, less a generous margin for a busy test machine.
    expect(room.ticks - before).toBeGreaterThanOrEqual(TICK_RATE_HZ / 2 - 3);

    await milo.room.leave();
    await dana.room.leave();
    await room.disconnect();
    await settled(() => pondering[0]?.aborted === true);
  });
});
