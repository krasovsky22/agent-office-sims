/**
 * CEO authority over the project board's work, checked end to end against a
 * real room over real sockets.
 *
 * The rules themselves are tested in `@sim/shared`'s `work.test.ts`. What
 * only a running room can show is that they hold for a client that skips the
 * UI and sends a command straight down the socket, that the role is assigned
 * and passed on the way the issue says, and that a dropped connection comes
 * back with its role. So these tests boot a Colyseus server and drive it with
 * the same client library the browser uses.
 *
 * Nobody on the floor can be given an issue yet, so where a test needs work
 * to act on it puts it in the room's state directly, as an assignment would.
 */

import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import {
  type BoardIssue,
  CEO_CHANGE,
  type CeoChangedEvent,
  CLIENT_MESSAGE,
  EMPTY_BOARD_LISTS,
  IssueWork,
  OFFICE_ROOM_NAME,
  type OfficeState,
  PLAYER_ROLE,
  type ProjectBoardSnapshot,
  SERVER_MESSAGE,
  WORK_ACTION,
  WORK_REJECTION,
  WORK_STATUS,
  type WorkRejectedEvent,
  type WorkStatus,
  isCeo,
  workKey,
} from "@sim/shared";
import { Client, type Room } from "colyseus.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ProjectBoardSource } from "../github/feed.js";
import { describeRoleProblems } from "../sim/roles.js";
import { OfficeRoom, type OfficeRoomOptions } from "./OfficeRoom.js";

/** Short, so the test can watch a grace period run out. */
const GRACE_SECONDS = 1;

function issue(number: number, title: string): BoardIssue {
  return { number, title, body: `Details of ${title}.`, labels: [], assignees: [], pullRequests: [], closedAt: null };
}

const OPEN_ISSUES = [issue(1, "Fix the login redirect loop"), issue(2, "Write the onboarding email"), issue(3, "Draft the roadmap")];

function snapshotOf(open: readonly BoardIssue[], closed: readonly BoardIssue[] = []): ProjectBoardSnapshot {
  return {
    ...EMPTY_BOARD_LISTS,
    open,
    closed,
    counts: { open: open.length, inProgress: 0, pullRequests: 0 },
    repository: "acme/office",
    updatedAt: Date.now(),
    stale: false,
  };
}

/** A project board feed the test publishes to by hand, as a poll would. */
class FakeBoard implements ProjectBoardSource {
  private snapshot = snapshotOf(OPEN_ISSUES);
  private readonly listeners = new Set<(snapshot: ProjectBoardSnapshot) => void>();

  public current(): ProjectBoardSnapshot {
    return this.snapshot;
  }

  public subscribe(listener: (snapshot: ProjectBoardSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public publish(snapshot: ProjectBoardSnapshot): void {
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener(snapshot));
  }
}

const officeBoard = new FakeBoard();

let server: Server;
let endpoint: string;

beforeAll(async () => {
  server = new Server({ transport: new WebSocketTransport(), greet: false });
  server.define(OFFICE_ROOM_NAME, OfficeRoom, {
    reconnectGraceSeconds: GRACE_SECONDS,
    projectBoard: officeBoard,
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
  readonly rejections: WorkRejectedEvent[];
  readonly announcements: CeoChangedEvent[];
}

function listen(tab: Tab, room: Room<OfficeState>): void {
  tab.room = room;
  room.onMessage<WorkRejectedEvent>(SERVER_MESSAGE.workRejected, (event) => {
    tab.rejections.push(event);
  });
  room.onMessage<CeoChangedEvent>(SERVER_MESSAGE.ceoChanged, (event) => {
    tab.announcements.push(event);
  });
  // Registered so the client library does not warn about them; unused here.
  room.onMessage(SERVER_MESSAGE.throttled, () => undefined);
  room.onMessage(SERVER_MESSAGE.projectBoard, () => undefined);
}

/** Opens a fresh office as its first, and so CEO, occupant. */
async function openOffice(name: string, roomName = OFFICE_ROOM_NAME): Promise<Tab> {
  const client = new Client(endpoint);
  const room = await client.create<OfficeState>(roomName, { name });
  const tab: Tab = { client, room, rejections: [], announcements: [] };
  listen(tab, room);
  await settled(() => room.state.occupants?.size === serverRoom(tab).state.occupants.size);
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

/** Puts work on an issue straight into the room, as an assignment and the steps after it would have. */
function seedWork(tab: Tab, issueNumber: number, status: WorkStatus): void {
  const work = new IssueWork();
  work.issueNumber = issueNumber;
  work.title = OPEN_ISSUES.find((candidate) => candidate.number === issueNumber)?.title ?? "";
  work.status = status;
  work.assigneeId = "agent-1";
  work.outputArtifact = status === WORK_STATUS.review ? "the deliverable" : "";
  work.assignedAt = Date.now();
  work.updatedAt = work.assignedAt;
  serverRoom(tab).state.work.set(workKey(issueNumber), work);
}

/** The office's work as plain data, for an "unchanged" comparison. */
function workOf(tab: Tab): unknown {
  return serverRoom(tab).state.work.toJSON();
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

    // Something in review, so approve and reject have work to act on.
    seedWork(dana, 1, WORK_STATUS.review);

    const before = workOf(dana);
    const ceoOnly: readonly [string, unknown][] = [
      [CLIENT_MESSAGE.workAssign, { issueNumber: 2, assigneeId: "agent-1" }],
      [CLIENT_MESSAGE.workAssign, { issueNumber: 1, assigneeId: "agent-1" }],
      [CLIENT_MESSAGE.workRelease, { issueNumber: 1 }],
      [CLIENT_MESSAGE.workMove, { issueNumber: 1, status: WORK_STATUS.done }],
      [CLIENT_MESSAGE.workMove, { issueNumber: 1, status: WORK_STATUS.in_progress }],
    ];
    for (const [type, payload] of ceoOnly) {
      milo.room.send(type, payload);
    }
    await roundTrip(milo);

    expect(workOf(dana)).toEqual(before);
    expect(milo.rejections).toHaveLength(ceoOnly.length);
    for (const event of milo.rejections) {
      expect(event.rejection).toBe(WORK_REJECTION.forbidden);
    }
    expect(milo.rejections.map((event) => event.action)).toEqual([
      WORK_ACTION.assign,
      WORK_ACTION.assign,
      WORK_ACTION.release,
      WORK_ACTION.moveStatus,
      WORK_ACTION.moveStatus,
    ]);
    // Told only to the sender.
    expect(dana.rejections).toEqual([]);

    await milo.room.leave();
    await dana.room.leave();
  });

  it("hands out only open issues on the board, and only to someone who can take one", async () => {
    const dana = await openOffice("Dana");

    dana.room.send(CLIENT_MESSAGE.workAssign, { issueNumber: 99, assigneeId: "agent-1" });
    dana.room.send(CLIENT_MESSAGE.workAssign, { issueNumber: 2, assigneeId: dana.room.sessionId });
    dana.room.send(CLIENT_MESSAGE.workAssign, { issueNumber: 2, assigneeId: "agent-1" });
    await roundTrip(dana);

    expect(dana.rejections.map((event) => event.rejection)).toEqual([
      WORK_REJECTION.unknownIssue,
      WORK_REJECTION.unknownAssignee,
      WORK_REJECTION.unknownAssignee,
    ]);
    expect(serverRoom(dana).state.work.size).toBe(0);

    // Seen from Dana's tab, as the project board panel would see it.
    seedWork(dana, 2, WORK_STATUS.assigned);
    await settled(() => dana.room.state.work.get(workKey(2))?.title === "Write the onboarding email");
    dana.room.send(CLIENT_MESSAGE.workRelease, { issueNumber: 2 });
    await roundTrip(dana);
    expect(serverRoom(dana).state.work.size).toBe(0);

    await dana.room.leave();
  });

  it("stops judging a player as CEO the moment the role passes on", async () => {
    const dana = await openOffice("Dana");
    const milo = await joinOffice(dana, "Milo");

    await dana.room.leave();
    await settled(() => roleOf(milo, milo.room.sessionId) === PLAYER_ROLE.ceo);

    seedWork(milo, 1, WORK_STATUS.in_progress);
    milo.room.send(CLIENT_MESSAGE.workMove, { issueNumber: 1, status: WORK_STATUS.review });
    await roundTrip(milo);
    expect(milo.rejections).toEqual([]);
    expect(serverRoom(milo).state.work.get(workKey(1))?.status).toBe(WORK_STATUS.review);

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
      { ceoId: milo.room.sessionId, previousCeoId: dana.room.sessionId, change: CEO_CHANGE.succeeded },
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

describe("CEO succession past a dropped player", () => {
  it("promotes a connected player over an earlier one whose place is only held", async () => {
    const dana = await openOffice("Dana");
    const milo = await joinOffice(dana, "Milo");
    const ines = await joinOffice(dana, "Ines");
    const miloId = milo.room.sessionId;
    const token = milo.room.reconnectionToken;

    await milo.room.leave(false);
    await roundTrip(ines);
    expect(serverRoom(ines).state.occupants.has(miloId)).toBe(true);

    await dana.room.leave();
    await settled(() => ines.announcements.length === 1);
    expect(roleOf(ines, ines.room.sessionId)).toBe(PLAYER_ROLE.ceo);
    expect(roleOf(ines, miloId)).toBe(PLAYER_ROLE.exec);
    expect(ines.announcements).toEqual([
      { ceoId: ines.room.sessionId, previousCeoId: dana.room.sessionId, change: CEO_CHANGE.succeeded },
    ]);

    listen(milo, await milo.client.reconnect<OfficeState>(token));
    await roundTrip(milo);
    expect(roleOf(ines, miloId)).toBe(PLAYER_ROLE.exec);
    expect(describeRoleProblems(serverRoom(ines).state.occupants)).toEqual([]);

    await milo.room.leave();
    await ines.room.leave();
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
    seedWork(dana, 3, WORK_STATUS.in_progress);
    dana.room.send(CLIENT_MESSAGE.workMove, { issueNumber: 3, status: WORK_STATUS.review });
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
    expect(milo.announcements).toEqual([{ ceoId: milo.room.sessionId, previousCeoId: sessionId, change: CEO_CHANGE.succeeded }]);

    await milo.room.leave();
  });
});

describe("the project board's work", () => {
  it("puts the work down when GitHub closes the issue", async () => {
    const dana = await openOffice("Dana");
    const room = serverRoom(dana);
    seedWork(dana, 3, WORK_STATUS.in_progress);

    const closed = OPEN_ISSUES.find((candidate) => candidate.number === 3);
    if (closed === undefined) {
      throw new Error("no issue 3 on the board");
    }
    officeBoard.publish(
      snapshotOf(
        OPEN_ISSUES.filter((candidate) => candidate !== closed),
        [{ ...closed, body: "", closedAt: Date.now() }],
      ),
    );
    expect(room.state.work.has(workKey(3))).toBe(false);
    officeBoard.publish(snapshotOf(OPEN_ISSUES));

    await dana.room.leave();
  });
});
