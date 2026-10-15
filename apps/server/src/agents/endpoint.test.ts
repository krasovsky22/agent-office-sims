/**
 * The orchestrator's report route, over real HTTP.
 *
 * Mounted on the same `createHealthServer` the server boots with, so these also
 * prove the route is reachable beside the health check, and that everything a
 * stranger can send is refused before it reaches the registry.
 */

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { LIVE_AGENT_REPORT_STATUS } from "@sim/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { HEALTH_PATH, createHealthServer } from "../http.js";
import { LIVE_AGENT_REPORT_PATH, MAX_REPORT_BYTES, createLiveAgentEndpoint } from "./endpoint.js";
import { LiveAgentRegistry } from "./registry.js";

const SECRET = "a-shared-secret-long-enough";

let server: Server;
let baseUrl: string;
let registry: LiveAgentRegistry;
const clock = { now: 0 };

beforeAll(async () => {
  registry = new LiveAgentRegistry({ timeoutMs: 60_000, maxAgents: 3 });
  server = createHealthServer(
    new Map([
      [
        LIVE_AGENT_REPORT_PATH,
        createLiveAgentEndpoint({
          secret: SECRET,
          // Through a closure, so each test's fresh registry is the one reported to.
          registry: { report: (report) => registry.report(report) },
          now: () => clock.now,
        }),
      ],
    ]),
  );
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

beforeEach(() => {
  registry = new LiveAgentRegistry({ timeoutMs: 60_000, maxAgents: 3 });
  // Far enough on that the rate limit has refilled since the last test.
  clock.now += 60_000;
});

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}${LIVE_AGENT_REPORT_PATH}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const WORKING = {
  id: "agent-1",
  name: "Crewmate",
  status: LIVE_AGENT_REPORT_STATUS.working,
  task: { title: "Live coding agents", url: "https://github.com/o/r/issues/33" },
};

describe(`POST ${LIVE_AGENT_REPORT_PATH}`, () => {
  it("records a report carrying the secret", async () => {
    const response = await post(WORKING);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, id: "agent-1", status: "working" });
    expect(registry.current()).toEqual([
      { id: "agent-1", name: "Crewmate", status: "working", task: WORKING.task },
    ]);
  });

  it.each([
    ["no Authorization header", {}],
    ["the wrong secret", { Authorization: "Bearer not-the-secret" }],
    ["the secret with a suffix", { Authorization: `Bearer ${SECRET}x` }],
    ["the secret without the Bearer scheme", { Authorization: SECRET }],
  ])("rejects a report with %s, and records nothing", async (_label, headers) => {
    const response = await fetch(`${baseUrl}${LIVE_AGENT_REPORT_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(WORKING),
    });
    expect(response.status).toBe(401);
    const text = await response.text();
    expect(text).not.toContain(SECRET);
    expect(registry.current()).toEqual([]);
  });

  it("only accepts POST", async () => {
    const response = await fetch(`${baseUrl}${LIVE_AGENT_REPORT_PATH}`, {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it.each([
    ["not JSON", "{"],
    ["not a report", { hello: "world" }],
    ["an unknown status", { id: "a", status: "sleeping" }],
    ["a javascript: task link", { ...WORKING, task: { title: "x", url: "javascript:alert(1)" } }],
  ])("refuses a body that is %s", async (_label, body) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(registry.current()).toEqual([]);
  });

  it("refuses a body over the size limit", async () => {
    const response = await post({ ...WORKING, name: "x".repeat(MAX_REPORT_BYTES) });
    expect(response.status).toBe(413);
    expect(registry.current()).toEqual([]);
  });

  it("says when the office is full", async () => {
    for (const id of ["a", "b", "c"]) {
      expect((await post({ id, status: "idle" })).status).toBe(200);
    }
    expect((await post({ id: "d", status: "idle" })).status).toBe(409);
  });

  it("takes an agent off the floor when it reports it has stopped", async () => {
    await post(WORKING);
    const response = await post({ id: "agent-1", status: "stopped" });
    expect(response.status).toBe(200);
    expect(registry.current()).toEqual([]);
  });

  it("rate-limits a flood of authenticated reports instead of recording every one", async () => {
    const statuses = await Promise.all(
      Array.from({ length: 100 }, (_, index) => post({ id: `agent-${index % 3}`, status: "idle" })),
    ).then((responses) => responses.map((response) => response.status));
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
    expect(statuses.filter((status) => status === 200).length).toBeLessThanOrEqual(60);
  });

  it("leaves the health check where it was", async () => {
    const response = await fetch(`${baseUrl}${HEALTH_PATH}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});
