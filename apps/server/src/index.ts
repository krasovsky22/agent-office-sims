/**
 * Colyseus server boot.
 *
 * One room type, one port. The WebSocket transport is handed an HTTP server
 * that already answers `/health`, so the platform has something to probe and
 * the client still has nothing but a socket to talk to. Order is load-bearing
 * and explained in `./http.ts`.
 *
 * Behind a platform proxy this process still speaks plain HTTP and `ws://` on
 * its internal port; the proxy terminates TLS and the browser sees `https://`
 * and `wss://`. Nothing here needs to know that, which is why there is no TLS
 * configuration: the one thing that does change is the URL the client is built
 * with.
 */

import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { OFFICE_ROOM_NAME, TICK_RATE_HZ } from "@sim/shared";

import { readConfig } from "./config.js";
import { createHealthServer } from "./http.js";
import { restrictMatchmakingOrigins, verifyOrigin } from "./origins.js";
import { OfficeRoom } from "./rooms/OfficeRoom.js";

const { port, allowedOrigins } = readConfig();

restrictMatchmakingOrigins(allowedOrigins);

const server = new Server({
  transport: new WebSocketTransport({
    server: createHealthServer(),
    verifyClient: verifyOrigin(allowedOrigins),
  }),
});

server.define(OFFICE_ROOM_NAME, OfficeRoom);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.gracefullyShutdown();
  });
}

await server.listen(port);
/* eslint-disable no-console -- the lines a developer or a platform log needs on boot */
console.log(`office server listening on port ${port} at ${TICK_RATE_HZ}Hz`);
console.log(`allowed origins: ${allowedOrigins.join(", ")}`);
/* eslint-enable no-console */
