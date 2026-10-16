/**
 * The runner's sync route over real HTTP, and what it does to a live room.
 *
 * Mounted on the same `createHealthServer` the server boots with, and that
 * server handed to the WebSocket transport as `index.ts` does, so these prove
 * the route is reachable beside the rooms' sockets, that everything a stranger
 * can send is refused before it reaches the runner link, that a command keeps
 * coming back until it is acked, and that a runner's slots walk into the same
 * rooms as the orchestrator's agents without slowing the tick.
 */

import type { AddressInfo } from "node:net";

import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import {
  LIVE_AGENT_REPORT_STATUS,
  type LiveAgent,
  MAX_NAME_LENGTH,
  MAX_RUNNER_ACKS,
  MAX_RUNNER_EVENTS,
  MAX_RUNNER_SLOTS,
  MAX_TASK_URL_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_WORK_NOTE_LENGTH,
  type OfficeState,
  RUNNER_SYNC_PATH,
  type RunnerCommand,
  TICK_RATE_HZ,
  liveAgentKey,
} from "@sim/shared";
import { Client, type Room } from "colyseus.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { HEALTH_PATH, createHealthServer } from "../http.js";
import { OfficeRoom, type OfficeRoomOptions } from "../rooms/OfficeRoom.js";
import { CombinedLiveAgentSource } from "./combined.js";
import { LIVE_AGENT_REPORT_PATH, createLiveAgentEndpoint } from "./endpoint.js";
import { LiveAgentRegistry } from "./registry.js";
import { MAX_SYNC_BYTES, createRunnerEndpoint } from "./runnerEndpoint.js";
import { RunnerLink, runnerSlotAgentId } from "./runnerLink.js";

const SECRET = "a-runner-secret-long-enough";
const REPO = "krasovsky22/agent-office-sims";
const TIMEOUT_MS = 60_000;

/** The room the two-tab and flood tests open, fed by the link and registry that live for the whole file. */
const FLOOR_ROOM = "office-runner-floor";

let server: Server;
let baseUrl: string;
let wsUrl: string;
/** Swapped per test for the route tests; the room reads {@link floorLink}. */
let link: RunnerLink;
const clock = { now: 0 };

const floorLink = new RunnerLink({ repository: REPO, timeoutMs: TIMEOUT_MS });
const floorRegistry = new LiveAgentRegistry({ timeoutMs: TIMEOUT_MS, maxAgents: 4 });
const floor = new CombinedLiveAgentSource([floorRegistry, floorLink]);

beforeAll(async () => {
  const routes = new Map([
    [
      RUNNER_SYNC_PATH,
      createRunnerEndpoint({
        secret: SECRET,
        // Through a closure, so each test's fresh link is the one synced with.
        link: { sync: (sync) => link.sync(sync) },
        now: () => clock.now,
      }),
    ],
    ["/floor/runner/sync", createRunnerEndpoint({ secret: SECRET, link: floorLink })],
    [LIVE_AGENT_REPORT_PATH, createLiveAgentEndpoint({ secret: SECRET, registry: floorRegistry })],
  ]);
  server = new Server({ transport: new WebSocketTransport({ server: createHealthServer(routes) }), greet: false });
  server.define(FLOOR_ROOM, OfficeRoom, {
    liveAgents: floor,
    runnerEvents: floorLink,
  } satisfies Partial<OfficeRoomOptions>);
  await server.listen(0);
  const { port } = server.transport.server?.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}`;
});

afterAll(async () => {
  floor.stop();
  await server.gracefullyShutdown(false);
});

beforeEach(() => {
  link = new RunnerLink({ repository: REPO, timeoutMs: TIMEOUT_MS, now: () => clock.now });
  // Far enough on that the rate limit has refilled since the last test.
  clock.now += 60_000;
});

const SYNC = {
  runnerId: "runner-1",
  repo: REPO,
  acked: [] as string[],
  slots: [
    { id: "slot-1", name: "Claude 1", status: "idle" },
    { id: "slot-2", name: "Claude 2", status: "idle" },
  ],
  events: [],
};

function post(body: unknown, headers: Record<string, string> = {}, path = RUNNER_SYNC_PATH): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe(`POST ${RUNNER_SYNC_PATH}`, () => {
  it("takes a sync carrying the secret and answers with no commands", async () => {
    const response = await post(SYNC);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, commands: [] });
    expect(link.current().map((record) => record.id)).toEqual([
      "runner:runner-1:slot-1",
      "runner:runner-1:slot-2",
    ]);
  });

  it.each([
    ["no Authorization header", {}],
    ["the wrong secret", { Authorization: "Bearer not-the-secret" }],
    ["the secret with a suffix", { Authorization: `Bearer ${SECRET}x` }],
    ["the secret without the Bearer scheme", { Authorization: SECRET }],
  ])("rejects a sync with %s, and records nothing", async (_label, headers) => {
    const response = await fetch(`${baseUrl}${RUNNER_SYNC_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(SYNC),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(await response.text()).not.toContain(SECRET);
    expect(link.current()).toEqual([]);
  });

  it("only accepts POST", async () => {
    const response = await fetch(`${baseUrl}${RUNNER_SYNC_PATH}`, { headers: { Authorization: `Bearer ${SECRET}` } });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("checks the method before the secret", async () => {
    const response = await fetch(`${baseUrl}${RUNNER_SYNC_PATH}`, { method: "PUT" });
    expect(response.status).toBe(405);
  });

  it.each([
    ["not JSON", "{"],
    ["not a sync", { hello: "world" }],
    ["a slot with an unknown status", { ...SYNC, slots: [{ id: "slot-1", status: "sleeping" }] }],
  ])("refuses a body that is %s", async (_label, body) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(link.current()).toEqual([]);
  });

  it("refuses a body over the size limit", async () => {
    const response = await post({ ...SYNC, padding: "x".repeat(MAX_SYNC_BYTES) });
    expect(response.status).toBe(413);
    expect(link.current()).toEqual([]);
  });

  it("refuses a runner working on another repository", async () => {
    const response = await post({ ...SYNC, repo: "someone/else" });
    expect(response.status).toBe(403);
    expect(link.current()).toEqual([]);
  });

  it.each([
    ["plain ASCII", "x"],
    ["non-ASCII and escapes", "\u00e9\u2014\u{1F600}\u001b\"\\"],
  ])("takes the largest sync the contract allows, in %s", async (_label, characters) => {
    const cycle = Array.from(characters);
    const fill = (budget: number, prefix = ""): string => {
      let text = prefix;
      for (let index = 0; ; index += 1) {
        const next = `${text}${cycle[index % cycle.length]}`;
        if (Buffer.byteLength(JSON.stringify(next)) - 2 > budget) {
          return text;
        }
        text = next;
      }
    };
    const issueNumber = 0xffffffff;
    const pr = {
      number: issueNumber,
      title: fill(MAX_TITLE_LENGTH),
      url: fill(MAX_TASK_URL_LENGTH, `https://github.com/${REPO}/pull/1?q=`),
    };
    const body = JSON.stringify({
      runnerId: "r".repeat(32),
      repo: REPO,
      acked: Array.from({ length: MAX_RUNNER_ACKS }, (_, index) => `${index}`.padStart(64, "c")),
      slots: Array.from({ length: MAX_RUNNER_SLOTS }, (_, index) => ({
        id: `${index}`.padStart(32, "s"),
        name: fill(MAX_NAME_LENGTH),
        status: "needs-input",
        issueNumber,
        activity: fill(MAX_TITLE_LENGTH),
        pr,
      })),
      events: Array.from({ length: MAX_RUNNER_EVENTS }, (_, index) => ({
        id: `${index}`.padStart(64, "e"),
        kind: "pr-opened",
        slotId: "s".repeat(32),
        issueNumber,
        pr,
        message: fill(MAX_WORK_NOTE_LENGTH),
      })),
    });
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_SYNC_BYTES);
    const response = await post(body);
    expect(response.status).toBe(200);
    expect(link.current()).toHaveLength(MAX_RUNNER_SLOTS);
  });

  it("tells a runner reporting more slots than it may why it is refused", async () => {
    const slots = Array.from({ length: MAX_RUNNER_SLOTS + 1 }, (_, index) => ({ id: `slot-${index}`, status: "idle" }));
    const response = await post({ ...SYNC, slots });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: `a runner may report at most ${MAX_RUNNER_SLOTS} slots` });
    expect(link.current()).toEqual([]);
  });

  it("says when the office has no room for a runner's slots", async () => {
    await post({ ...SYNC, runnerId: "runner-2", slots: [{ id: "slot-1", status: "idle" }, { id: "slot-2", status: "idle" }, { id: "slot-3", status: "idle" }] });
    const response = await post(SYNC);
    expect(response.status).toBe(409);
  });

  it("rate-limits a flood of authenticated syncs instead of taking every one", async () => {
    const statuses = await Promise.all(Array.from({ length: 60 }, () => post(SYNC))).then((responses) =>
      responses.map((response) => response.status),
    );
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
    expect(statuses.filter((status) => status === 200).length).toBeLessThanOrEqual(20);
  });

  it("re-delivers a command in every reply until a sync acks it, and never after", async () => {
    await post(SYNC);
    const command = link.enqueue("runner-1", { kind: "stop", slotId: "slot-1", reason: "released" });
    const commandsIn = async (body: unknown): Promise<RunnerCommand[]> =>
      ((await (await post(body)).json()) as { commands: RunnerCommand[] }).commands;

    expect(await commandsIn(SYNC)).toEqual([command]);
    expect(await commandsIn(SYNC)).toEqual([command]);
    expect(await commandsIn({ ...SYNC, acked: [command?.id] })).toEqual([]);
    expect(await commandsIn(SYNC)).toEqual([]);
  });

  it("leaves the health check where it was", async () => {
    const response = await fetch(`${baseUrl}${HEALTH_PATH}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
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

/** Opens a tab that ignores the room's broadcasts, which these tests do not read. */
function quiet(room: Room<OfficeState>): Room<OfficeState> {
  room.onMessage("*", () => undefined);
  return room;
}

function liveAgentIn(room: Room<OfficeState>, id: string): LiveAgent | undefined {
  return room.state.occupants?.get(liveAgentKey(id)) as LiveAgent | undefined;
}

describe("runner slots in a live room", () => {
  it("shows a runner's slots beside the orchestrator's agents, the same in two tabs", async () => {
    const first = quiet(await new Client(wsUrl).create<OfficeState>(FLOOR_ROOM, { name: "Dana" }));
    const second = quiet(await new Client(wsUrl).joinById<OfficeState>(first.roomId, { name: "Milo" }));
    try {
      expect((await post(SYNC, {}, "/floor/runner/sync")).status).toBe(200);
      expect(
        (await post({ id: "agent-1", name: "Crewmate", status: LIVE_AGENT_REPORT_STATUS.idle }, {}, LIVE_AGENT_REPORT_PATH)).status,
      ).toBe(200);

      const slot = runnerSlotAgentId("runner-1", "slot-1");
      for (const tab of [first, second]) {
        await settled(() => liveAgentIn(tab, slot) !== undefined && liveAgentIn(tab, "agent-1") !== undefined);
        expect(liveAgentIn(tab, slot)?.name).toBe("Claude 1");
        expect(liveAgentIn(tab, runnerSlotAgentId("runner-1", "slot-2"))?.name).toBe("Claude 2");
      }

      // A slot waiting on a person still holds its issue, and every tab sees what it waits on.
      await post(
        { ...SYNC, slots: [{ id: "slot-1", name: "Claude 1", status: "needs-input", issueNumber: 39, activity: "Waiting for approval" }] },
        {},
        "/floor/runner/sync",
      );
      for (const tab of [first, second]) {
        await settled(() => liveAgentIn(tab, slot)?.status === "needs-input");
        expect(liveAgentIn(tab, slot)?.activity).toBe("Waiting for approval");
        expect(liveAgentIn(tab, slot)?.taskUrl).toBe(`https://github.com/${REPO}/issues/39`);
        await settled(() => liveAgentIn(tab, runnerSlotAgentId("runner-1", "slot-2")) === undefined);
      }

      // Resuming clears it everywhere.
      await post(
        { ...SYNC, slots: [{ id: "slot-1", name: "Claude 1", status: "working", issueNumber: 39, activity: "Bash: pnpm test" }] },
        {},
        "/floor/runner/sync",
      );
      for (const tab of [first, second]) {
        await settled(() => liveAgentIn(tab, slot)?.status === "working");
        expect(liveAgentIn(tab, slot)?.activity).toBe("Bash: pnpm test");
      }
    } finally {
      await first.leave();
      await second.leave();
    }
  });

  it("keeps the room ticking at full rate through a flood of syncs", async () => {
    const tab = quiet(await new Client(wsUrl).create<OfficeState>(FLOOR_ROOM, { name: "Dana" }));
    try {
      const room = serverRoom(tab);
      const events = Array.from({ length: 32 }, (_, index) => ({
        id: `event-${index}`,
        kind: "started",
        slotId: "slot-1",
        issueNumber: 39,
      }));
      const body = { ...SYNC, runnerId: "runner-flood", events };
      const startTick = room.state.tick;
      const startedAt = performance.now();
      // Authenticated syncs past the rate limit, strangers, and bodies over the
      // size limit, in waves, for about a second.
      while (performance.now() - startedAt < 1000) {
        await Promise.all([
          ...Array.from({ length: 20 }, () => post(body, {}, "/floor/runner/sync")),
          ...Array.from({ length: 10 }, () => post(body, { Authorization: "Bearer wrong" }, "/floor/runner/sync")),
          ...Array.from({ length: 5 }, () => post({ ...body, padding: "x".repeat(MAX_SYNC_BYTES) }, {}, "/floor/runner/sync")),
        ]);
      }
      const elapsedMs = performance.now() - startedAt;
      const ticks = room.state.tick - startTick;
      const expected = (elapsedMs / 1000) * TICK_RATE_HZ;
      expect(ticks).toBeGreaterThanOrEqual(Math.floor(expected * 0.9));
    } finally {
      await tab.leave();
    }
  });
});
