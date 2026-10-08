/**
 * What the platform and the browser see over HTTP, checked against a real boot.
 *
 * These go through a genuine Colyseus `Server` rather than calling the handler
 * directly, because the two things most likely to break are both consequences
 * of that server existing: it replaces the HTTP `request` listener (so the
 * health route can be silently lost) and it owns the matchmaking response's
 * cross-origin headers (so the allowlist can be silently bypassed).
 */

import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { OFFICE_ROOM_NAME } from "@sim/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HEALTH_PATH, createHealthServer } from "./http.js";
import { restrictMatchmakingOrigins } from "./origins.js";
import { OfficeRoom } from "./rooms/OfficeRoom.js";

const ALLOWED = "https://office.example.com";
const MATCHMAKE_URL = `/matchmake/joinOrCreate/${OFFICE_ROOM_NAME}`;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  restrictMatchmakingOrigins([ALLOWED]);
  server = new Server({
    transport: new WebSocketTransport({ server: createHealthServer() }),
    greet: false,
  });
  server.define(OFFICE_ROOM_NAME, OfficeRoom);

  // Port 0 so the test does not fight whatever is already on 2567.
  await server.listen(0);
  const address = server.transport.server?.address();
  if (address === null || address === undefined || typeof address === "string") {
    throw new Error("the transport did not bind a TCP port");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await server.gracefullyShutdown(false);
});

describe("the health route", () => {
  it("survives Colyseus taking over the request listener", async () => {
    const response = await fetch(`${baseUrl}${HEALTH_PATH}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("answers a probe that appends a query string", async () => {
    const response = await fetch(`${baseUrl}${HEALTH_PATH}?from=platform`);
    expect(response.status).toBe(200);
  });

  it("is the whole HTTP surface — nothing else is served", async () => {
    expect((await fetch(`${baseUrl}/`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/index.html`)).status).toBe(404);
  });

  it("refuses a method it does not implement", async () => {
    const response = await fetch(`${baseUrl}${HEALTH_PATH}`, { method: "DELETE" });
    expect(response.status).toBe(405);
  });
});

describe("matchmaking cross-origin headers", () => {
  it("makes the response readable to an allowed origin", async () => {
    const response = await fetch(`${baseUrl}${MATCHMAKE_URL}`, {
      method: "OPTIONS",
      headers: { Origin: ALLOWED },
    });
    expect(response.headers.get("access-control-allow-origin")).toBe(ALLOWED);
    expect(response.headers.get("vary")).toBe("Origin");
  });

  it("does not echo an origin that is not on the list, and never answers with a wildcard", async () => {
    const response = await fetch(`${baseUrl}${MATCHMAKE_URL}`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example.com" },
    });
    const allowOrigin = response.headers.get("access-control-allow-origin");
    expect(allowOrigin).not.toBe("https://evil.example.com");
    expect(allowOrigin).not.toBe("*");
  });
});
