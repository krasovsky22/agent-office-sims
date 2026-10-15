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
 *
 * The project board's GitHub feed is made here, once, rather than per room: one
 * poll loop serves every room, and its token stays in this process.
 *
 * How agents do ticket work is read here too, so a model mode with no API key
 * stops the server at boot rather than failing the first ticket an agent takes.
 */

import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { OFFICE_ROOM_NAME, RECONNECT_GRACE_SECONDS, TICK_RATE_HZ } from "@sim/shared";

import { readConfig } from "./config.js";
import { createGithubLoader } from "./github/client.js";
import { ProjectFeed } from "./github/feed.js";
import { createHealthServer } from "./http.js";
import { restrictMatchmakingOrigins, verifyOrigin } from "./origins.js";
import { OfficeRoom, type OfficeRoomOptions } from "./rooms/OfficeRoom.js";
import { describeAgentWork } from "./work/fromConfig.js";

const { port, allowedOrigins, projectBoard, agentWork, agentCount } = readConfig();

const projectFeed = new ProjectFeed({
  repository: projectBoard.repository,
  load: createGithubLoader({ repository: projectBoard.repository, token: projectBoard.token }),
  intervalMs: projectBoard.pollIntervalMs,
  // eslint-disable-next-line no-console -- a stale or recovered feed is an operator's business
  log: (line) => console.warn(line),
});

restrictMatchmakingOrigins(allowedOrigins);

const server = new Server({
  transport: new WebSocketTransport({
    server: createHealthServer(),
    verifyClient: verifyOrigin(allowedOrigins),
  }),
});

// Colyseus lets these server options win a collision with a client's join
// options, so a client can never supply the feed or the size of the staff.
server.define(OFFICE_ROOM_NAME, OfficeRoom, {
  projectBoard: projectFeed,
  agentCount,
  reconnectGraceSeconds: RECONNECT_GRACE_SECONDS,
} satisfies OfficeRoomOptions);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    projectFeed.stop();
    void server.gracefullyShutdown();
  });
}

await server.listen(port);
projectFeed.start();
/* eslint-disable no-console -- the lines a developer or a platform log needs on boot */
console.log(`office server listening on port ${port} at ${TICK_RATE_HZ}Hz`);
console.log(`allowed origins: ${allowedOrigins.join(", ")}`);
console.log(
  `project board: ${projectBoard.repository} every ${projectBoard.pollIntervalMs / 1000}s, ` +
    (projectBoard.token === undefined ? "anonymous" : "with a token"),
);
console.log(describeAgentWork(agentWork));
console.log(`agent employees per room: ${agentCount}`);
/* eslint-enable no-console */
