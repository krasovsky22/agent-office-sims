/**
 * Standing tasks end to end: a live room with two tabs, the runner link over
 * real HTTP, and the runner's own standing scheduler with the mock's scripted
 * runs, so what each tab's roster and conversation show is what the office
 * would show for a real runner.
 *
 * The CEO sets the pull request watch up by asking the AI Manager; it shows
 * in both tabs' state; an executive's buttons and words are refused with the
 * reason; a pull request opened afterwards is reviewed, as a simulated review
 * that posts nothing; anyone reads its runs on the wall board, with their
 * logs; only the CEO changes how often it runs; and the CEO's buttons pause
 * it, and the CEO's words remove it. GitHub is a fixture: nothing here
 * reaches it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import {
  CLIENT_MESSAGE,
  EMPTY_BOARD_LISTS,
  MANAGER_ENTRY_KIND,
  MANAGER_REJECTION,
  type ManagerEntry,
  type ManagerRejectedEvent,
  OFFICE_ROOM_NAME,
  type OfficeState,
  type ProjectBoardSnapshot,
  RUNNER_SYNC_PATH,
  SERVER_MESSAGE,
  STANDING_REJECTION,
  type StandingHistoryEvent,
  type StandingRejectedEvent,
  defaultAgentName,
} from "@sim/shared";
import { Client, type Room } from "colyseus.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SpendLedger } from "../../../runner/src/budget.js";
import { SlotPool } from "../../../runner/src/slots.js";
import { createMockStandingRunners } from "../../../runner/src/standing/mock.js";
import type { OpenPull, PullSource } from "../../../runner/src/standing/pulls.js";
import { StandingScheduler } from "../../../runner/src/standing/scheduler.js";
import { StandingStore } from "../../../runner/src/standing/store.js";
import { createSyncClient } from "../../../runner/src/syncClient.js";
import { SyncLoop } from "../../../runner/src/syncLoop.js";
import { createRunnerEndpoint } from "../agents/runnerEndpoint.js";
import { RunnerLink } from "../agents/runnerLink.js";
import { StandingMirror } from "../agents/standingMirror.js";
import { createHealthServer } from "../http.js";
import { officeRoom } from "../rooms/OfficeRoom.js";
import { createManagerAdvisor } from "./advisor.js";
import { createRulePlanner } from "./fromConfig.js";

const REPO = "acme/office";
const SECRET = "a-runner-secret-long-enough";
const SYNC_GAP_MS = 100;

const BOARD: ProjectBoardSnapshot = { ...EMPTY_BOARD_LISTS, repository: REPO, updatedAt: 1, stale: false, counts: { open: 0, inProgress: 0, pullRequests: 0 } };

const mirror = new StandingMirror();
const link = new RunnerLink({ repository: REPO, timeoutMs: 60_000, standing: mirror });
const http = createHealthServer(new Map([[RUNNER_SYNC_PATH, createRunnerEndpoint({ secret: SECRET, link })]]));
let server: Server;
let endpoint: string;
let dataDir: string;
let scheduler: StandingScheduler;
let syncing = true;
let syncs: Promise<void> | undefined;

/** GitHub's open pull requests, as the test says they are. */
let open: OpenPull[] = [{ number: 100, title: "Already open", draft: false, author: "dana", association: "OWNER", ownAgent: false, headSha: "a" }];
const pulls: PullSource = async () => ({ kind: "listed", etag: undefined, pulls: [...open] });

beforeAll(async () => {
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const serverUrl = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}`);
  server = new Server({ transport: new WebSocketTransport(), greet: false });
  server.define(OFFICE_ROOM_NAME, officeRoom({
    projectBoard: { current: () => BOARD, subscribe: () => () => undefined },
    manager: createManagerAdvisor({ planner: createRulePlanner(0), mode: "rules" }),
    liveAgents: link,
    runnerEvents: link,
    runnerCommands: link,
    standing: mirror,
  }));
  await server.listen(0);
  const address = server.transport.server?.address();
  if (address === null || address === undefined || typeof address === "string") {
    throw new Error("the transport did not bind a TCP port");
  }
  endpoint = `ws://127.0.0.1:${address.port}`;

  dataDir = mkdtempSync(join(tmpdir(), "sim-standing-round-trip-"));
  const ledger = new SpendLedger({ budgetUsd: undefined });
  const pool = new SlotPool({
    count: 2,
    agent: { label: "Mock", start: () => ({ stop: () => Promise.resolve() }) },
    workspaces: { open: async () => dataDir, close: async () => undefined },
    taskTimeoutMs: 60_000,
    runnerId: "runner-1",
    ledger,
  });
  scheduler = new StandingScheduler({
    store: new StandingStore({ file: join(dataDir, "standing.json") }),
    pool,
    runners: createMockStandingRunners({ stepMs: 50, minPollIntervalMs: 0 }),
    pulls,
    ledger,
    budgetUsd: undefined,
    maxConcurrent: 1,
    tickMs: 100,
  });
  scheduler.start();
  const loop = new SyncLoop({ runnerId: "runner-1", repo: REPO, pool, standing: scheduler, client: createSyncClient({ serverUrl, secret: SECRET }) });
  syncs = (async () => {
    while (syncing) {
      await loop.syncOnce();
      await new Promise((resolve) => setTimeout(resolve, SYNC_GAP_MS));
    }
  })();
});

afterAll(async () => {
  syncing = false;
  await syncs;
  scheduler.stop();
  await server.gracefullyShutdown(false);
  await new Promise((resolve) => http.close(resolve));
  rmSync(dataDir, { recursive: true, force: true });
});

interface Tab {
  readonly room: Room<OfficeState>;
  readonly entries: ManagerEntry[];
  readonly standingRejected: StandingRejectedEvent[];
  readonly managerRejected: ManagerRejectedEvent[];
  readonly history: StandingHistoryEvent[];
}

async function joinTab(name: string, create: boolean, roomId?: string): Promise<Tab> {
  const client = new Client(endpoint);
  const room =
    create || roomId === undefined
      ? await client.create<OfficeState>(OFFICE_ROOM_NAME, { name })
      : await client.joinById<OfficeState>(roomId, { name });
  const tab: Tab = { room, entries: [], standingRejected: [], managerRejected: [], history: [] };
  room.onMessage<StandingHistoryEvent>(SERVER_MESSAGE.standingHistory, (event) => tab.history.push(event));
  room.onMessage<ManagerEntry>(SERVER_MESSAGE.managerEntry, (entry) => tab.entries.push(entry));
  room.onMessage<StandingRejectedEvent>(SERVER_MESSAGE.standingRejected, (event) => tab.standingRejected.push(event));
  room.onMessage<ManagerRejectedEvent>(SERVER_MESSAGE.managerRejected, (event) => tab.managerRejected.push(event));
  for (const ignored of [SERVER_MESSAGE.managerHistory, SERVER_MESSAGE.projectBoard, SERVER_MESSAGE.ceoChanged, SERVER_MESSAGE.chat, SERVER_MESSAGE.screens]) {
    room.onMessage(ignored, () => undefined);
  }
  return tab;
}

async function settled(ready: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the office");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function lines(tab: Tab, kind: ManagerEntry["kind"]): string[] {
  return tab.entries.filter((entry) => entry.kind === kind).map((entry) => entry.text);
}

/** The task as a tab's client holds it, from the patches it was sent. */
function row(tab: Tab): { name: string; status: string; lastOutcome: string; lastRunPr: number } | undefined {
  const [task] = [...tab.room.state.standing.values()];
  return task === undefined ? undefined : { name: task.name, status: task.status, lastOutcome: task.lastOutcome, lastRunPr: task.lastRunPr };
}

/** The occupant key of the first of the runner's coding agents a tab sees. */
function firstAgentId(tab: Tab): string {
  return [...tab.room.state.occupants.values()].find((occupant) => occupant.id.startsWith("agent:runner:"))?.id ?? "";
}

/** The runner's first agent's default name, as its runner id gives it. */
const FIRST = defaultAgentName("runner-1", 0);

describe("a standing task from the AI Manager to the mock runner and back", () => {
  it("is set up by the CEO's words, shown in every tab, refused to anyone else, and runs", { timeout: 60_000 }, async () => {
    const dana = await joinTab("Dana", true);
    const eve = await joinTab("Eve", false, dana.room.roomId);
    await settled(() => link.hasRunner("runner-1"));

    dana.room.send(CLIENT_MESSAGE.managerSay, { text: "watch for new pull requests" });
    await settled(() => lines(dana, MANAGER_ENTRY_KIND.reply).length === 1);
    expect(lines(dana, MANAGER_ENTRY_KIND.reply)[0]).toMatch(/^Here's how that went:\n✓ “Watch for new pull requests” is set up on runner-1/);
    // Both tabs list it once the runner has taken it and had its first look.
    await settled(() => row(dana)?.status === "active" && row(eve)?.status === "active");
    expect(row(eve)).toMatchObject({ name: "Watch for new pull requests", status: "active" });
    const taskId = [...dana.room.state.standing.keys()][0] ?? "";

    // Not the executive's to touch, by button or by word.
    eve.room.send(CLIENT_MESSAGE.standingPause, { taskId });
    eve.room.send(CLIENT_MESSAGE.managerSay, { text: "stop watching pull requests" });
    await settled(() => eve.standingRejected.length === 1 && eve.managerRejected.length === 1);
    expect(eve.standingRejected).toEqual([{ action: "pause", taskId, rejection: STANDING_REJECTION.forbidden }]);
    expect(eve.managerRejected).toEqual([{ rejection: MANAGER_REJECTION.forbidden }]);
    expect(row(dana)?.status).toBe("active");

    // A pull request opened after the watch began is reviewed; the one already open never is.
    open = [...open, { number: 112, title: "Add a lift", draft: false, author: "dana", association: "OWNER", ownAgent: false, headSha: "b" }];
    dana.room.send(CLIENT_MESSAGE.standingCheckNow, { taskId });
    const simulated = `${FIRST} did a simulated review of PR #112 “Add a lift” for “Watch for new pull requests”; nothing was posted on GitHub.`;
    await settled(() => lines(eve, MANAGER_ENTRY_KIND.update).includes(simulated));
    await settled(() => row(eve)?.lastOutcome === "simulated");
    expect(row(eve)).toMatchObject({ lastOutcome: "simulated", lastRunPr: 112 });
    expect(JSON.stringify(dana.entries)).not.toContain("#100");

    // The wall board: anyone reads its runs with their logs, and only the CEO changes how often it runs.
    await settled(() => mirror.standingRuns(taskId).some((run) => run.outcome === "simulated"));
    eve.room.send(CLIENT_MESSAGE.standingHistory, { taskId });
    await settled(() => eve.history.length === 1);
    expect(eve.history[0]?.runs.find((run) => run.outcome === "simulated")).toMatchObject({
      taskId,
      pr: { number: 112, title: "Add a lift" },
      agent: FIRST,
      url: `https://github.com/${REPO}/pull/112`,
      log: expect.stringContaining("Read: .sims-review/pr.diff"),
    });
    eve.room.send(CLIENT_MESSAGE.standingReschedule, { taskId, schedule: { intervalSeconds: 600 } });
    await settled(() => eve.standingRejected.length === 2);
    expect(eve.standingRejected[1]).toEqual({ action: "reschedule", taskId, rejection: STANDING_REJECTION.forbidden });
    dana.room.send(CLIENT_MESSAGE.standingReschedule, { taskId, schedule: { intervalSeconds: 600 } });
    await settled(() => eve.room.state.standing.get(taskId)?.intervalSeconds === 600);
    expect(eve.room.state.standing.get(taskId)?.trigger).toBe("every 10 min");

    // A new task from the board's form: refused to the executive, set up for the CEO on the agent she picked.
    const create = { kind: "schedule", instruction: "List the open pull requests", cron: "0 9 * * 1-5", agentId: firstAgentId(dana) };
    eve.room.send(CLIENT_MESSAGE.standingCreate, create);
    await settled(() => eve.standingRejected.length === 3);
    expect(eve.standingRejected[2]).toEqual({ action: "create", taskId: "", rejection: STANDING_REJECTION.forbidden });
    dana.room.send(CLIENT_MESSAGE.standingCreate, create);
    await settled(() => [...eve.room.state.standing.values()].some((task) => task.name === "List the open pull requests"));
    const created = [...eve.room.state.standing.values()].find((task) => task.name === "List the open pull requests");
    expect(created).toMatchObject({ kind: "schedule", cron: "0 9 * * 1-5", agentId: create.agentId });
    dana.room.send(CLIENT_MESSAGE.standingRemove, { taskId: created?.id ?? "" });
    await settled(() => eve.room.state.standing.size === 1);
    // The CEO's standing commands share one allowance, four at once and one more every five seconds.
    await new Promise((resolve) => setTimeout(resolve, 5_200));

    // A schedule firing too often is refused with the reason, not dropped.
    dana.room.send(CLIENT_MESSAGE.standingReschedule, { taskId, schedule: { cron: "* * * * *" } });
    await settled(() => dana.standingRejected.length === 1);
    expect(dana.standingRejected[0]).toEqual({
      action: "reschedule",
      taskId,
      rejection: STANDING_REJECTION.invalid,
      reason: "I can't schedule that: it would fire more often than every 5 minutes.",
    });
    await new Promise((resolve) => setTimeout(resolve, 5_200));
    dana.room.send(CLIENT_MESSAGE.standingCreate, { ...create, cron: "* * * * *" });
    await settled(() => dana.standingRejected.length === 2);
    expect(dana.standingRejected[1]).toEqual({
      action: "create",
      taskId: "",
      rejection: STANDING_REJECTION.invalid,
      reason: "I can't schedule that: it would fire more often than every 5 minutes.",
    });
    await new Promise((resolve) => setTimeout(resolve, 5_200));

    dana.room.send(CLIENT_MESSAGE.standingPause, { taskId });
    await settled(() => row(eve)?.status === "paused");

    dana.room.send(CLIENT_MESSAGE.managerSay, { text: "stop watching pull requests" });
    await settled(() => row(dana) === undefined && row(eve) === undefined);
    expect(lines(dana, MANAGER_ENTRY_KIND.reply).at(-1)).toBe(
      "Here's how that went:\n✓ Removed “Watch for new pull requests”; a run of it under way is stopped.",
    );
    expect(matchMaker.getLocalRoomById(dana.room.roomId)).toBeDefined();
    await eve.room.leave();
    await dana.room.leave();
  });
});
