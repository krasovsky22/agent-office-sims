/**
 * The runner against the game server's own runner link, over real HTTP: the
 * issue's acceptance, end to end.
 *
 * A mock runner's two slots reach the floor idle, a start command queued the
 * way the server queues one round-trips to `started` and back to idle, and a
 * runner that goes silent leaves the floor once the timeout passes. The
 * server's route and link are imported from its source rather than started as
 * a process, so the test owns the clock the timeout is measured by; the
 * floor's rendering of those slots is the server's own tests'.
 */

import type { AddressInfo } from "node:net";

import { LIVE_AGENT_STATUS, RUNNER_SYNC_PATH } from "@sim/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createHealthServer } from "../../server/src/http.js";
import { createRunnerEndpoint } from "../../server/src/agents/runnerEndpoint.js";
import { RunnerLink, type RunnerEventRecord } from "../../server/src/agents/runnerLink.js";
import { createMockAgent } from "./agents/mock.js";
import { SlotPool } from "./slots.js";
import { createSyncClient } from "./syncClient.js";
import { SyncLoop } from "./syncLoop.js";

const SECRET = "a-runner-secret-long-enough";
const REPO = "krasovsky22/agent-office-sims";
const TIMEOUT_MS = 60_000;
const STEP_MS = 20;

const clock = { now: 1_000_000 };
const link = new RunnerLink({ repository: REPO, timeoutMs: TIMEOUT_MS, now: () => clock.now });
const server = createHealthServer(new Map([[RUNNER_SYNC_PATH, createRunnerEndpoint({ secret: SECRET, link })]]));
let serverUrl: URL;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  serverUrl = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function runner(outcome: "failed" | "pr-opened") {
  const pool = new SlotPool({
    count: 2,
    agent: createMockAgent({ outcome, repo: REPO, stepMs: STEP_MS }),
    taskTimeoutMs: TIMEOUT_MS,
  });
  const loop = new SyncLoop({
    runnerId: "runner-1",
    repo: REPO,
    pool,
    client: createSyncClient({ serverUrl, secret: SECRET }),
  });
  return { pool, loop };
}

/** Syncs until `done` holds, the way the loop would a second apart. */
async function syncUntil(loop: SyncLoop, done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    expect(await loop.syncOnce()).toBe(true);
    if (done()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, STEP_MS / 2));
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

    await syncUntil(loop, () => {
      events.push(...inbox.drain());
      return events.some((record) => record.event.kind === "pr-opened");
    });
    expect(events.map((record) => [record.event.kind, record.event.slotId, record.event.issueNumber])).toEqual([
      ["started", "slot-1", 39],
      ["pr-opened", "slot-1", 39],
    ]);
    expect(events[1]?.event.pr?.url).toBe(`https://github.com/${REPO}/pull/1000039`);

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
      pool: new SlotPool({ count: 1, agent: createMockAgent({ outcome: "failed", repo: REPO }), taskTimeoutMs: TIMEOUT_MS }),
      client: createSyncClient({ serverUrl, secret: "not-the-server-secret" }),
      log: (line) => logged.push(line),
    });
    const logged: string[] = [];
    expect(await loop.syncOnce()).toBe(false);
    expect(logged).toEqual(["sync failed: refused with HTTP 401: unauthorized; retrying with backoff"]);
  });
});
