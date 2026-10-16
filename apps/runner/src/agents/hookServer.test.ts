/**
 * The hook server takes an event only from the process its token was made
 * for, and only while that process runs.
 */

import { request } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HOOK_PATH, HookServer } from "./hookServer.js";

let server: HookServer;
const heard: [string, unknown][] = [];

beforeEach(async () => {
  server = await HookServer.start();
  heard.length = 0;
});

afterEach(async () => {
  await server.close();
});

function post(runId: string, event: string, token: string | undefined, body = "{}"): Promise<Response> {
  const url = new URL(HOOK_PATH, server.url);
  url.searchParams.set("run", runId);
  url.searchParams.set("event", event);
  return fetch(url, {
    method: "POST",
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    body,
  });
}

describe("HookServer", () => {
  it("listens on loopback only", () => {
    expect(new URL(server.url).hostname).toBe("127.0.0.1");
  });

  it("passes an event with the run's token to its handler", async () => {
    const route = server.register((event, payload) => heard.push([event, payload]));
    const response = await post(route.runId, "PreToolUse", route.token, '{"tool_name":"Bash"}');
    expect(response.status).toBe(200);
    expect(heard).toEqual([["PreToolUse", { tool_name: "Bash" }]]);
  });

  it("refuses a missing or wrong token with 401, and hears nothing", async () => {
    const route = server.register((event, payload) => heard.push([event, payload]));
    expect((await post(route.runId, "Stop", undefined)).status).toBe(401);
    expect((await post(route.runId, "Stop", "")).status).toBe(401);
    expect((await post(route.runId, "Stop", `${route.token}x`)).status).toBe(401);
    expect((await post(route.runId, "Stop", route.token.slice(1))).status).toBe(401);
    expect(heard).toEqual([]);
  });

  it("refuses another run's token, and a run it does not know", async () => {
    const mine = server.register((event) => heard.push([`mine ${event}`, undefined]));
    const theirs = server.register((event) => heard.push([`theirs ${event}`, undefined]));
    expect((await post(mine.runId, "Stop", theirs.token)).status).toBe(401);
    expect((await post("no-such-run", "Stop", mine.token)).status).toBe(401);
    expect(heard).toEqual([]);
  });

  it("refuses a token once its process has ended", async () => {
    const route = server.register((event) => heard.push([event, undefined]));
    route.dispose();
    expect((await post(route.runId, "Stop", route.token)).status).toBe(401);
    expect(heard).toEqual([]);
  });

  it("counts a body that is not JSON as the event with nothing in it", async () => {
    const route = server.register((event, payload) => heard.push([event, payload]));
    expect((await post(route.runId, "Stop", route.token, "not json")).status).toBe(200);
    expect(heard).toEqual([["Stop", {}]]);
  });

  it("drops an event whose hook gives up partway through its body, and carries on", async () => {
    const route = server.register((event, payload) => heard.push([event, payload]));
    const url = new URL(HOOK_PATH, server.url);
    url.searchParams.set("run", route.runId);
    url.searchParams.set("event", "PreToolUse");
    const cut = request(url, {
      method: "POST",
      headers: { authorization: `Bearer ${route.token}`, "content-length": "1000" },
    });
    cut.on("error", () => undefined);
    cut.write('{"tool_name":');
    await sleep(50);
    cut.destroy();
    await sleep(50);
    expect(heard).toEqual([]);
    expect((await post(route.runId, "Stop", route.token)).status).toBe(200);
    expect(heard).toEqual([["Stop", {}]]);
  });

  it("refuses an event name that is not one", async () => {
    const route = server.register((event) => heard.push([event, undefined]));
    expect((await post(route.runId, "Stop&x=1", route.token)).status).toBe(400);
    expect(heard).toEqual([]);
  });

  it("answers anything but a POST to its route with 404 or 405", async () => {
    const route = server.register(() => undefined);
    expect((await fetch(new URL("/other", server.url), { method: "POST" })).status).toBe(404);
    const get = new URL(HOOK_PATH, server.url);
    get.searchParams.set("run", route.runId);
    expect((await fetch(get, { headers: { authorization: `Bearer ${route.token}` } })).status).toBe(405);
  });
});
