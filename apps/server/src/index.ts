/**
 * Colyseus server boot.
 *
 * One room type, one transport, no HTTP app: the client talks to this over a
 * WebSocket and nothing else needs serving.
 */

import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { OFFICE_ROOM_NAME, TICK_RATE_HZ } from "@sim/shared";

import { OfficeRoom } from "./rooms/OfficeRoom.js";

const DEFAULT_PORT = 2567;

function readPort(): number {
  const raw = process.env["PORT"];
  if (raw === undefined || raw === "") {
    return DEFAULT_PORT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`PORT must be a valid port number, got "${raw}"`);
  }
  return parsed;
}

const port = readPort();
const server = new Server({ transport: new WebSocketTransport() });

server.define(OFFICE_ROOM_NAME, OfficeRoom);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.gracefullyShutdown();
  });
}

await server.listen(port);
// eslint-disable-next-line no-console -- the one line a developer needs on boot
console.log(`office server listening on ws://localhost:${port} at ${TICK_RATE_HZ}Hz`);
