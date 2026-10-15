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
 * poll loop serves every room, and its token stays in this process. The live
 * agents' registry is made here for the same reason, and its report route is
 * only attached when a secret is configured.
 *
 * How agents do ticket work is read here too, so a model mode with no API key
 * stops the server at boot rather than failing the first ticket an agent takes.
 */

import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { OFFICE_ROOM_NAME, RECONNECT_GRACE_SECONDS, TICK_RATE_HZ } from "@sim/shared";

import { LIVE_AGENT_REPORT_PATH, createLiveAgentEndpoint } from "./agents/endpoint.js";
import { LiveAgentRegistry } from "./agents/registry.js";
import { readConfig } from "./config.js";
import { createGithubLoader } from "./github/client.js";
import { ProjectFeed } from "./github/feed.js";
import { type RouteHandler, createHealthServer } from "./http.js";
import { restrictMatchmakingOrigins, verifyOrigin } from "./origins.js";
import { OfficeRoom, type OfficeRoomOptions } from "./rooms/OfficeRoom.js";
import { createConfiguredExecutor, describeAgentWork } from "./work/fromConfig.js";

const { port, allowedOrigins, projectBoard, agentWork, agentCount, agentDebug, liveAgents } =
  readConfig();

const projectFeed = new ProjectFeed({
  repository: projectBoard.repository,
  load: createGithubLoader({ repository: projectBoard.repository, token: projectBoard.token }),
  intervalMs: projectBoard.pollIntervalMs,
  // eslint-disable-next-line no-console -- a stale or recovered feed is an operator's business
  log: (line) => console.warn(line),
});

/** Most live agents on the floor at once: a little over half the open floor's chairs. */
const MAX_LIVE_AGENTS = 12;

const liveAgentRegistry =
  liveAgents.secret === undefined
    ? undefined
    : new LiveAgentRegistry({ timeoutMs: liveAgents.timeoutMs, maxAgents: MAX_LIVE_AGENTS });

const routes = new Map<string, RouteHandler>();
if (liveAgentRegistry !== undefined && liveAgents.secret !== undefined) {
  routes.set(
    LIVE_AGENT_REPORT_PATH,
    createLiveAgentEndpoint({ secret: liveAgents.secret, registry: liveAgentRegistry }),
  );
}

restrictMatchmakingOrigins(allowedOrigins);

const server = new Server({
  transport: new WebSocketTransport({
    server: createHealthServer(routes),
    verifyClient: verifyOrigin(allowedOrigins),
  }),
});

// Colyseus lets these server options win a collision with a client's join
// options, so a client can never supply the feed, the size of the staff, the
// way the staff work, or its own permission to send debug commands. The
// executor is made once, so its call budget is the whole server's.
server.define(OFFICE_ROOM_NAME, OfficeRoom, {
  projectBoard: projectFeed,
  agentCount,
  reconnectGraceSeconds: RECONNECT_GRACE_SECONDS,
  agentDebug,
  workExecutor: createConfiguredExecutor(agentWork),
  ...(liveAgentRegistry === undefined ? {} : { liveAgents: liveAgentRegistry }),
} satisfies OfficeRoomOptions);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    projectFeed.stop();
    liveAgentRegistry?.stop();
    void server.gracefullyShutdown();
  });
}

await server.listen(port);
projectFeed.start();
liveAgentRegistry?.start();
/* eslint-disable no-console -- the lines a developer or a platform log needs on boot */
console.log(`office server listening on port ${port} at ${TICK_RATE_HZ}Hz`);
console.log(`allowed origins: ${allowedOrigins.join(", ")}`);
console.log(
  `project board: ${projectBoard.repository} every ${projectBoard.pollIntervalMs / 1000}s, ` +
    (projectBoard.token === undefined ? "anonymous" : "with a token"),
);
console.log(describeAgentWork(agentWork));
console.log(`agent employees per room: ${agentCount}`);
console.log(`agent debug commands: ${agentDebug ? "on" : "off"}`);


console.log(
  liveAgents.secret === undefined
    ? "live agents: off (LIVE_AGENTS_SECRET is not set)"
    : `live agents: POST ${LIVE_AGENT_REPORT_PATH}, leaving after ${liveAgents.timeoutMs / 1000}s of silence`,
);
/* eslint-enable no-console */
