/**
 * The runner's screens route over real HTTP, and what it does to a live room.
 *
 * Mounted on the same `createHealthServer` the server boots with, beside the
 * sync route and handed to the WebSocket transport as `index.ts` does, so
 * these prove that everything a stranger can send is refused before it
 * reaches the store, that a client walking in gets every screen whole and
 * then the same diffs as everyone else, and that a flood of screens never
 * slows the tick.
 */

import type { AddressInfo } from "node:net";

import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import {
  MAX_RUNNER_SCREENS_BYTES,
  type OfficeState,
  RUNNER_SCREENS_PATH,
  RUNNER_SYNC_PATH,
  SERVER_MESSAGE,
  type ScreenFrame,
  type ScreenFramesEvent,
  TICK_RATE_HZ,
} from "@sim/shared";
import { Client, type Room } from "colyseus.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createHealthServer } from "../http.js";
import { OfficeRoom, officeRoom } from "../rooms/OfficeRoom.js";
import { createRunnerEndpoint } from "./runnerEndpoint.js";
import { RunnerLink } from "./runnerLink.js";
import { ScreenStore } from "./screens.js";
import { createScreensEndpoint } from "./screensEndpoint.js";

const SECRET = "a-runner-secret-long-enough";
const REPO = "krasovsky22/agent-office-sims";
const TIMEOUT_MS = 60_000;

/** The room the two-tab and flood tests open, fed by the link and store that live for the whole file. */
const SCREENS_ROOM = "office-runner-screens";
const FLOOR_SYNC = "/floor/runner/sync";
const FLOOR_SCREENS = "/floor/runner/screens";

let server: Server;
let baseUrl: string;
let wsUrl: string;
/** Swapped per test for the route tests; the room reads {@link floorStore}. */
let store: ScreenStore;
let link: RunnerLink;
const clock = { now: 0 };

const floorLink = new RunnerLink({ repository: REPO, timeoutMs: TIMEOUT_MS });
const floorStore = new ScreenStore({ slots: floorLink });

const SYNC = {
  runnerId: "runner-1",
  repo: REPO,
  acked: [] as string[],
  slots: [
    { id: "slot-1", name: "Mock 1", status: "idle" },
    { id: "slot-2", name: "Mock 2", status: "idle" },
  ],
  events: [],
};

const FULL: ScreenFrame = {
  cols: 40,
  rows: 4,
  lines: {
    0: [
      ["mock agent", -1, -1, 1],
      [" on #39", -1, -1, 0],
    ],
    1: [["● Reading issue #39", 6, -1, 0]],
    2: [],
    3: [],
  },
  full: true,
  cursor: [0, 2],
};

const DIFF: ScreenFrame = {
  cols: 40,
  rows: 4,
  lines: { 2: [["● Bash: pnpm test", 6, -1, 0]] },
  full: false,
  cursor: [0, 3],
  history: [[["$ claude", -1, -1, 0]]],
};

beforeAll(async () => {
  const routes = new Map([
    [RUNNER_SYNC_PATH, createRunnerEndpoint({ secret: SECRET, link: { sync: (sync) => link.sync(sync) } })],
    [
      RUNNER_SCREENS_PATH,
      createScreensEndpoint({
        secret: SECRET,
        // Through a closure, so each test's fresh store is the one posted to.
        store: { accept: (batch) => store.accept(batch) },
        now: () => clock.now,
      }),
    ],
    [FLOOR_SYNC, createRunnerEndpoint({ secret: SECRET, link: floorLink })],
    [FLOOR_SCREENS, createScreensEndpoint({ secret: SECRET, store: floorStore })],
  ]);
  server = new Server({ transport: new WebSocketTransport({ server: createHealthServer(routes) }), greet: false });
  server.define(SCREENS_ROOM, officeRoom({
    liveAgents: floorLink,
    screens: floorStore,
  }));
  await server.listen(0);
  const { port } = server.transport.server?.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}`;
});

afterAll(async () => {
  floorStore.stop();
  await server.gracefullyShutdown(false);
});

beforeEach(async () => {
  link = new RunnerLink({ repository: REPO, timeoutMs: TIMEOUT_MS });
  store = new ScreenStore({ slots: link });
  // Far enough on that the rate limit has refilled since the last test.
  clock.now += 60_000;
  expect((await post(SYNC, {}, RUNNER_SYNC_PATH)).status).toBe(200);
});

function post(body: unknown, headers: Record<string, string> = {}, path = RUNNER_SCREENS_PATH): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function batch(...screens: { slotId: string; frame: ScreenFrame }[]) {
  return { runnerId: "runner-1", screens };
}

describe(`POST ${RUNNER_SCREENS_PATH}`, () => {
  it("takes a batch carrying the secret, and answers with nothing to resend", async () => {
    const response = await post(batch({ slotId: "slot-1", frame: FULL }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, resend: [] });
    expect(store.fullScreens().screens.map((screen) => screen.occupantId)).toEqual(["agent:runner:runner-1:slot-1"]);
  });

  it("names a slot whose diff it could not apply", async () => {
    const response = await post(batch({ slotId: "slot-1", frame: FULL }, { slotId: "slot-2", frame: DIFF }));
    expect(await response.json()).toEqual({ ok: true, resend: ["slot-2"] });
  });

  it("refuses a batch posted before its runner's sync, and keeps nothing of it", async () => {
    const response = await post({ runnerId: "runner-2", screens: [{ slotId: "slot-1", frame: FULL }] });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "runner not synced" });
    expect(store.fullScreens().screens).toEqual([]);
  });

  it("names a slot its runner has not reported, and keeps nothing of it", async () => {
    const response = await post(batch({ slotId: "slot-9", frame: FULL }));
    expect(await response.json()).toEqual({ ok: true, resend: ["slot-9"] });
    expect(store.fullScreens().screens).toEqual([]);
  });

  it.each([
    ["no Authorization header", { Authorization: "" }],
    ["the wrong secret", { Authorization: "Bearer not-the-secret" }],
    ["the secret without the Bearer scheme", { Authorization: SECRET }],
  ])("rejects a batch with %s, and keeps nothing", async (_label, headers) => {
    const response = await post(batch({ slotId: "slot-1", frame: FULL }), headers);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(store.fullScreens().screens).toEqual([]);
  });

  it("rejects anything but POST", async () => {
    const response = await fetch(`${baseUrl}${RUNNER_SCREENS_PATH}`, { headers: { Authorization: `Bearer ${SECRET}` } });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("rejects a batch over the size limit, declared or streamed", async () => {
    const padded = { ...batch({ slotId: "slot-1", frame: FULL }), padding: "x".repeat(MAX_RUNNER_SCREENS_BYTES) };
    expect((await post(padded)).status).toBe(413);
    const streamed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(padded)));
        controller.close();
      },
    });
    const response = await fetch(`${baseUrl}${RUNNER_SCREENS_PATH}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      body: streamed,
      duplex: "half",
    } as RequestInit);
    expect(response.status).toBe(413);
    expect(store.fullScreens().screens).toEqual([]);
  });

  it("rejects a body that is not JSON", async () => {
    const response = await post("{not json");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "body is not JSON" });
  });

  it("rejects a malformed batch, and keeps none of it", async () => {
    const response = await post(batch({ slotId: "slot-1", frame: FULL }, { slotId: "slot-2", frame: { ...FULL, cols: 9999 } }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "not a batch of screens" });
    expect(store.fullScreens().screens).toEqual([]);
  });

  it("rate-limits a flood of authenticated batches with 429", async () => {
    const responses = await Promise.all(Array.from({ length: 60 }, () => post(batch({ slotId: "slot-1", frame: FULL }))));
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
    expect(statuses.filter((status) => status === 200).length).toBeLessThanOrEqual(16);
    expect(responses.find((response) => response.status === 429)?.headers.get("retry-after")).toBe("1");
  });

  it("never echoes the secret, whatever it answers", async () => {
    const texts = await Promise.all(
      [
        post(batch({ slotId: "slot-1", frame: FULL })),
        post("{not json"),
        post({ runnerId: SECRET, screens: [] }),
        post(batch(), { Authorization: `Bearer ${SECRET}x` }),
      ].map(async (response) => (await response).text()),
    );
    for (const text of texts) {
      expect(text).not.toContain(SECRET);
    }
  });
});

/** The room instance itself, for reading the authoritative state. */
function serverRoom(room: Room<OfficeState>): OfficeRoom {
  return matchMaker.getLocalRoomById(room.roomId) as OfficeRoom;
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

/** A tab that records every `screens` message it gets, and ignores the rest. */
async function tab(join: (client: Client) => Promise<Room<OfficeState>>) {
  const received: ScreenFramesEvent[] = [];
  const client = new Client(wsUrl);
  const room = await join(client);
  room.onMessage("*", () => undefined);
  room.onMessage(SERVER_MESSAGE.screens, (event: ScreenFramesEvent) => received.push(event));
  return { room, received };
}

describe("screens in a live room", () => {
  it("hands a joining tab every screen whole, then the same diffs as everyone", async () => {
    expect((await post(SYNC, {}, FLOOR_SYNC)).status).toBe(200);
    expect((await post(batch({ slotId: "slot-1", frame: FULL }), {}, FLOOR_SCREENS)).status).toBe(200);

    const first = await tab((client) => client.create<OfficeState>(SCREENS_ROOM, { name: "Dana" }));
    const second = await tab((client) => client.joinById<OfficeState>(first.room.roomId, { name: "Milo" }));
    try {
      const occupantId = "agent:runner:runner-1:slot-1";
      const whole: ScreenFramesEvent = { screens: [{ occupantId, frame: { ...FULL, history: [], historyCleared: true } }] };
      for (const { received } of [first, second]) {
        await settled(() => received.length === 1);
        expect(received).toEqual([whole]);
      }

      expect((await post(batch({ slotId: "slot-1", frame: DIFF }), {}, FLOOR_SCREENS)).status).toBe(200);
      for (const { received } of [first, second]) {
        await settled(() => received.length === 2);
      }
      expect(first.received).toEqual([whole, { screens: [{ occupantId, frame: DIFF }] }]);
      expect(second.received).toEqual(first.received);

      // A third tab walks in after the diff, and gets the screen with it applied, its history as the scrollback.
      const third = await tab((client) => client.joinById<OfficeState>(first.room.roomId, { name: "Ines" }));
      try {
        await settled(() => third.received.length === 1);
        expect(third.received[0]?.screens[0]?.frame).toEqual({
          ...FULL,
          lines: { ...FULL.lines, 2: DIFF.lines[2] },
          cursor: DIFF.cursor,
          history: DIFF.history,
          historyCleared: true,
        });
      } finally {
        await third.room.leave();
      }
    } finally {
      await first.room.leave();
      await second.room.leave();
    }
  });

  it("hands a tab that reconnects after a drop every screen whole again", async () => {
    expect((await post(SYNC, {}, FLOOR_SYNC)).status).toBe(200);
    expect((await post(batch({ slotId: "slot-1", frame: FULL }), {}, FLOOR_SCREENS)).status).toBe(200);

    const client = new Client(wsUrl);
    const first = await client.create<OfficeState>(SCREENS_ROOM, { name: "Dana" });
    const token = first.reconnectionToken;
    // A drop, not a leave: the socket closes without the client saying so.
    await first.leave(false);
    expect((await post(batch({ slotId: "slot-1", frame: DIFF }), {}, FLOOR_SCREENS)).status).toBe(200);

    const reconnected = await tab((joiner) => joiner.reconnect<OfficeState>(token));
    try {
      expect(reconnected.room.sessionId).toBe(first.sessionId);
      await settled(() => reconnected.received.length === 1);
      expect(reconnected.received).toEqual([
        {
          screens: [
            {
              occupantId: "agent:runner:runner-1:slot-1",
              frame: {
                ...FULL,
                lines: { ...FULL.lines, 2: DIFF.lines[2] },
                cursor: DIFF.cursor,
                // The server's screens outlive a test, so earlier diffs' history may be there too.
                history: expect.arrayContaining([...(DIFF.history ?? [])]) as unknown,
                historyCleared: true,
              },
            },
          ],
        },
      ]);
    } finally {
      await reconnected.room.leave();
    }
  });

  it("keeps the room ticking at full rate through a flood of screens", async () => {
    expect((await post(SYNC, {}, FLOOR_SYNC)).status).toBe(200);
    const { room: client } = await tab((joiner) => joiner.create<OfficeState>(SCREENS_ROOM, { name: "Dana" }));
    try {
      const room = serverRoom(client);
      const body = JSON.stringify(batch({ slotId: "slot-1", frame: FULL }, { slotId: "slot-2", frame: FULL }));
      const oversized = JSON.stringify({ ...batch(), padding: "x".repeat(MAX_RUNNER_SCREENS_BYTES) });
      /** Ticks per second over about `ms`, while `load` runs back to back. */
      const tickRate = async (ms: number, load: () => Promise<void>): Promise<number> => {
        const startTick = room.ticks;
        const startedAt = performance.now();
        while (performance.now() - startedAt < ms) {
          await load();
        }
        return (room.ticks - startTick) / ((performance.now() - startedAt) / 1000);
      };
      // The same length of quiet first, so the comparison is with this room
      // on this machine right now, however busy the rest of the test run
      // keeps it, rather than with the tick rate on paper.
      const quiet = await tickRate(1000, () => new Promise((resolve) => setTimeout(resolve, 50)));
      let limited = 0;
      // Authenticated batches past the rate limit, strangers, and bodies over
      // the size limit, in waves.
      const flooded = await tickRate(1000, async () => {
        const responses = await Promise.all([
          ...Array.from({ length: 20 }, () => post(body, {}, FLOOR_SCREENS)),
          ...Array.from({ length: 10 }, () => post(body, { Authorization: "Bearer wrong" }, FLOOR_SCREENS)),
          ...Array.from({ length: 5 }, () => post(oversized, {}, FLOOR_SCREENS)),
        ]);
        limited += responses.filter((response) => response.status === 429).length;
      });
      expect(limited).toBeGreaterThan(0);
      expect(quiet).toBeGreaterThan(TICK_RATE_HZ / 2);
      expect(flooded).toBeGreaterThanOrEqual(quiet * 0.9);
    } finally {
      await client.leave();
    }
  });
});
