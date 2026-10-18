/**
 * The runner against the game server's own runner link, over real HTTP: the
 * issue's acceptance, end to end.
 *
 * A mock runner's two slots reach the floor idle, a start command queued the
 * way the server queues one round-trips to `started`, through a wait on a
 * person that holds until the server's prompt answers it, to a simulated pull
 * request and back to idle, its
 * work done in a worktree of its own cut from a temporary origin, and a
 * runner that goes silent leaves the floor once the timeout passes. Its
 * slots' screens reach the server's screen store as the mock prints, and the
 * runner's secret never does, whatever an agent prints. The
 * server's route and link are imported from its source rather than started as
 * a process, so the test owns the clock the timeout is measured by; the
 * floor's rendering of those slots is the server's own tests'.
 */

import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { LIVE_AGENT_STATUS, RUNNER_SCREENS_PATH, RUNNER_SYNC_PATH, type ScreenFramesEvent } from "@sim/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createHealthServer } from "../../server/src/http.js";
import { createRunnerEndpoint } from "../../server/src/agents/runnerEndpoint.js";
import { RunnerLink, type RunnerEventRecord } from "../../server/src/agents/runnerLink.js";
import { ScreenStore } from "../../server/src/agents/screens.js";
import { createScreensEndpoint } from "../../server/src/agents/screensEndpoint.js";
import { MOCK_PERMISSION, createMockAgent } from "./agents/mock.js";
import type { Agent } from "./agents/types.js";
import { type GitFixture, gitFixture } from "./gitFixture.js";
import { createRedactor } from "./redact.js";
import { ScreenLoop } from "./screenLoop.js";
import { createScreensClient } from "./screensClient.js";
import { SlotWorktrees } from "./slotWorktrees.js";
import { SlotPool } from "./slots.js";
import { createSyncClient } from "./syncClient.js";
import { SyncLoop } from "./syncLoop.js";
import { Worktrees } from "./worktrees.js";

const SECRET = "a-runner-secret-long-enough";
const REPO = "krasovsky22/agent-office-sims";
const TIMEOUT_MS = 60_000;
/** Between one sync and the next: as fast as the server's rate limit refills, while worktrees take real time. */
const SYNC_GAP_MS = 100;
/** Each step outlasts a sync gap, so a sync sees even the mock's shortest state. */
const STEP_MS = SYNC_GAP_MS * 2;

const clock = { now: 1_000_000 };
const link = new RunnerLink({ repository: REPO, timeoutMs: TIMEOUT_MS, now: () => clock.now });
const store = new ScreenStore({ slots: link });
const server = createHealthServer(
  new Map([
    [RUNNER_SYNC_PATH, createRunnerEndpoint({ secret: SECRET, link })],
    [RUNNER_SCREENS_PATH, createScreensEndpoint({ secret: SECRET, store })],
  ]),
);
let serverUrl: URL;
let fixture: GitFixture;
let workspaces: SlotWorktrees;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  serverUrl = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  fixture = gitFixture();
  workspaces = new SlotWorktrees({
    worktrees: new Worktrees({
      repoDir: join(fixture.dataDir, "repo"),
      worktreesDir: join(fixture.dataDir, "worktrees"),
      clone: fixture.clone,
    }),
    stateFile: join(fixture.dataDir, "worktrees.json"),
  });
  // As the runner does at boot, so the first start does not wait on the clone.
  await workspaces.reattach();
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  fixture.cleanup();
});

function runner(outcome: "failed" | "pr-opened", agent?: Agent) {
  const pool = new SlotPool({
    count: 2,
    agent: agent ?? createMockAgent({ outcome, stepMs: STEP_MS }),
    workspaces,
    taskTimeoutMs: TIMEOUT_MS,
  });
  const loop = new SyncLoop({
    runnerId: "runner-1",
    repo: REPO,
    pool,
    client: createSyncClient({ serverUrl, secret: SECRET }),
  });
  const screens = new ScreenLoop({
    runnerId: "runner-1",
    screens: () => pool.screens(),
    redactor: createRedactor([SECRET]),
    client: createScreensClient({ serverUrl, secret: SECRET }),
  });
  return { pool, loop, screens };
}

/** The text on a slot's screen as the server's store holds it, row by row. */
function storedText(slotId: string): string[] {
  const screen = store.fullScreens().screens.find((candidate) => candidate.occupantId === `agent:runner:runner-1:${slotId}`);
  return Object.values(screen?.frame.lines ?? {})
    .map((runs) => runs.map((run) => run[0]).join(""))
    .filter((text) => text !== "");
}

/** Posts screens until `done` holds, the way the loop would a quarter second apart. */
async function postUntil(screens: ScreenLoop, done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await screens.flushOnce();
    if (done()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, STEP_MS / 2));
  }
  throw new Error("the screens never got there");
}

/** Syncs until `done` holds, the way the loop would a second apart. */
async function syncUntil(loop: SyncLoop, done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    expect(await loop.syncOnce()).toBe(true);
    if (done()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, SYNC_GAP_MS));
  }
  throw new Error("the runner never got there");
}

describe("the mock runner and the server's runner link", () => {
  it("puts two idle slots on the floor, round-trips a start to started and back, and leaves when it goes silent", async () => {
    const inbox = link.openEventInbox();
    const events: RunnerEventRecord[] = [];
    const { pool, loop } = runner("pr-opened");

    await loop.syncOnce();
    expect(link.current().map((agent) => [agent.id, agent.name, agent.status])).toEqual([
      ["runner:runner-1:slot-1", "Mock 1", LIVE_AGENT_STATUS.idle],
      ["runner:runner-1:slot-2", "Mock 2", LIVE_AGENT_STATUS.idle],
    ]);

    const command = link.enqueue("runner-1", {
      kind: "start",
      slotId: "slot-1",
      issueNumber: 39,
      title: "Night shift",
      url: `https://github.com/${REPO}/issues/39`,
      note: "put someone on #39",
      requestedBy: "Dana",
    });
    expect(command).toBeDefined();

    await syncUntil(loop, () => link.current()[0]?.status === LIVE_AGENT_STATUS.working);
    expect(link.current()[0]?.task).toEqual({ title: "Night shift", url: `https://github.com/${REPO}/issues/39` });

    // The mock stops to wait on a person, still on its issue, and waits for
    // as long as nobody answers: ten of its steps and more go by.
    await syncUntil(loop, () => link.current()[0]?.status === LIVE_AGENT_STATUS.needsInput);
    for (let sync = 0; sync < 10; sync += 1) {
      await new Promise((resolve) => setTimeout(resolve, STEP_MS));
      expect(await loop.syncOnce()).toBe(true);
    }
    expect(link.current()[0]).toMatchObject({
      status: LIVE_AGENT_STATUS.needsInput,
      activity: MOCK_PERMISSION,
      task: { title: "Night shift", url: `https://github.com/${REPO}/issues/39` },
    });
    // A prompt from the server is the answer, and it carries on.
    link.enqueue("runner-1", { kind: "prompt", slotId: "slot-1", text: "Go ahead.", requestedBy: "Dana" });
    await syncUntil(loop, () => link.current()[0]?.status === LIVE_AGENT_STATUS.working);

    await syncUntil(loop, () => {
      events.push(...inbox.drain());
      return events.some((record) => record.event.kind === "pr-opened");
    });
    expect(events.map((record) => [record.event.kind, record.event.slotId, record.event.issueNumber])).toEqual([
      ["started", "slot-1", 39],
      ["pr-opened", "slot-1", 39],
    ]);
    // Simulated: nothing on GitHub, so nothing to link.
    expect(events[1]?.event.pr).toEqual({ number: 1_000_039, title: "[mock] Night shift", url: "", simulated: true });
    // Its commit is in its own worktree, kept since nothing pushed it.
    await workspaces.settled();
    expect(workspaces.current().map((record) => [record.slotId, record.issueNumber])).toEqual([["slot-1", 39]]);
    expect(fixture.git(join(fixture.dataDir, "worktrees", "issue-39-slot-1"), "log", "-1", "--format=%s")).toBe(
      "mock: work on #39",
    );

    // Back to idle, and the start was acked: the server sends it no more.
    expect(link.current().map((agent) => agent.status)).toEqual([LIVE_AGENT_STATUS.idle, LIVE_AGENT_STATUS.idle]);
    expect(link.pending("runner-1")).toEqual([]);
    expect(pool.pendingEvents()).toEqual([]);

    // Killed: it syncs no more, and the server lets its slots go after the timeout.
    loop.stop();
    clock.now += TIMEOUT_MS - 1;
    link.sweep();
    expect(link.current()).toHaveLength(2);
    clock.now += 2;
    link.sweep();
    expect(link.current()).toEqual([]);
    inbox.close();
  });

  it("is refused, and says so, when its secret is not the server's", async () => {
    const loop = new SyncLoop({
      runnerId: "runner-2",
      repo: REPO,
      pool: new SlotPool({
        count: 1,
        agent: createMockAgent({ outcome: "failed" }),
        workspaces,
        taskTimeoutMs: TIMEOUT_MS,
      }),
      client: createSyncClient({ serverUrl, secret: "not-the-server-secret" }),
      log: (line) => logged.push(line),
    });
    const logged: string[] = [];
    expect(await loop.syncOnce()).toBe(false);
    expect(logged).toEqual(["sync failed: refused with HTTP 401: unauthorized; retrying with backoff"]);
  });
});

describe("the mock runner's screens and the server's screen store", () => {
  it("puts each slot's screen in the store, then the mock's work as diffs, the same for every room", async () => {
    const heard: ScreenFramesEvent[] = [];
    const stopHearing = store.onScreens((event) => heard.push(event));
    const { pool, loop, screens } = runner("pr-opened");
    await loop.syncOnce();
    // Each idle screen whole before it is first posted, so a busy machine parsing it late is no diff.
    await Promise.all(pool.screens().map(([, screen]) => screen.written()));

    await postUntil(screens, () => storedText("slot-2").length > 0);
    expect(storedText("slot-1")).toEqual(["Mock 1 is waiting for work."]);
    expect(storedText("slot-2")).toEqual(["Mock 2 is waiting for work."]);
    expect(heard[0]?.screens.map((screen) => screen.frame.full)).toEqual([true, true]);

    link.enqueue("runner-1", {
      kind: "start",
      slotId: "slot-1",
      issueNumber: 39,
      title: "Night shift",
      url: `https://github.com/${REPO}/issues/39`,
      note: "",
      requestedBy: "Dana",
    });
    await loop.syncOnce();
    await postUntil(screens, () => storedText("slot-1").some((row) => row.includes("Enter to confirm")));
    // The CEO answers its permission menu with keys, which reach it in the order pressed.
    for (const key of ["down", "up", "enter"] as const) {
      link.enqueue("runner-1", { kind: "key", slotId: "slot-1", key, requestedBy: "Dana" });
    }
    await loop.syncOnce();
    await postUntil(screens, () => storedText("slot-1").some((row) => row.startsWith("✓ ")));
    expect(storedText("slot-1")).toEqual([
      "mock agent on #39: Night shift",
      "for Dana",
      "● Reading issue #39",
      "● Edit: .sims-mock/issue-39.md",
      "● Bash: git commit",
      `? ${MOCK_PERMISSION}`,
      "  Do you want to proceed?",
      "❯ 1. Yes",
      "  2. No, and tell the agent what to do differently (esc)",
      "  ↑/↓ to move · Enter to confirm · Esc to cancel",
      "  ✓ Yes",
      "● Bash: pnpm test",
      "✓ Handed in a simulated pull request; nothing was opened on GitHub",
    ]);
    // After the first whole screens, only diffs, and only for the slot at work.
    const later = heard.slice(1).flatMap((event) => event.screens);
    expect(later.length).toBeGreaterThan(0);
    expect(later.every((screen) => !screen.frame.full && screen.occupantId === "agent:runner:runner-1:slot-1")).toBe(true);
    stopHearing();
  });

  it("never lets the runner's secret reach the server, however an agent prints it", async () => {
    const heard: ScreenFramesEvent[] = [];
    const stopHearing = store.onScreens((event) => heard.push(event));
    const leaky: Agent = {
      label: "Leaky",
      start: (_task, reporter) => {
        reporter.started();
        reporter.output(`$ env\r\nRUNNER_SECRET=${SECRET}\r\n`);
        reporter.output(`\u001b[33m${SECRET.slice(0, 9)}\u001b[1m${SECRET.slice(9)}\u001b[0m\r\n`);
        reporter.output(`${"x".repeat(90)}${SECRET}\r\n`);
        return { stop: () => undefined };
      },
    };
    const { loop, screens } = runner("failed", leaky);
    await loop.syncOnce();
    link.enqueue("runner-1", {
      kind: "start",
      slotId: "slot-1",
      issueNumber: 39,
      title: "Night shift",
      url: `https://github.com/${REPO}/issues/39`,
      note: "",
      requestedBy: "Dana",
    });
    await loop.syncOnce();
    await postUntil(screens, () => storedText("slot-1").includes("$ env"));

    expect(storedText("slot-1")[1]).toBe(`RUNNER_SECRET=${"*".repeat(SECRET.length)}`);
    for (const seen of [JSON.stringify(store.fullScreens()), JSON.stringify(heard)]) {
      expect(seen).not.toContain(SECRET.slice(0, 9));
      expect(seen).not.toContain(SECRET.slice(9));
    }
    stopHearing();
  });
});
