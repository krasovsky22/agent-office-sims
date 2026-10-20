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
 * How the AI manager answers is read here too, so a model mode with no API key
 * stops the server at boot rather than failing the CEO's first question. The
 * manager's queue of work for the live agents is made beside the registry it
 * wraps, and its collection route is attached with the report route. The runner link is made
 * here too, with its sync route only when `RUNNER_SECRET` is set, and the rooms
 * read its slots and the orchestrator's agents as one feed. The slots' screen
 * store and its route come with the link, since a screen belongs to a slot,
 * and so does the mirror of every runner's standing tasks, made once so a room
 * opened later shows them at once.
 */

import { join } from "node:path";

import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import {
  MAX_LIVE_AGENTS,
  type IssueState,
  type IssueStateRejection,
  MAX_RUNNER_SLOTS,
  OFFICE_ROOM_NAME,
  RECONNECT_GRACE_SECONDS,
  RUNNER_SCREENS_PATH,
  RUNNER_SYNC_PATH,
  TICK_RATE_HZ,
  retiredAgentIssueLabelNotice,
} from "@sim/shared";

import {
  LIVE_AGENT_ASSIGNMENTS_PATH,
  LIVE_AGENT_REPORT_PATH,
  createAssignmentEndpoint,
  createLiveAgentEndpoint,
} from "./agents/endpoint.js";
import { CombinedLiveAgentSource } from "./agents/combined.js";
import { type LiveAgentSource, LiveAgentRegistry } from "./agents/registry.js";
import { createRunnerEndpoint } from "./agents/runnerEndpoint.js";
import { RunnerLink } from "./agents/runnerLink.js";
import { RunnerProfileFile } from "./agents/runnerProfiles.js";
import { ScreenStore } from "./agents/screens.js";
import { StandingMirror } from "./agents/standingMirror.js";
import { createScreensEndpoint } from "./agents/screensEndpoint.js";
import { readConfig } from "./config.js";
import { createGithubLoader } from "./github/client.js";
import { createConfiguredManager, describeManager } from "./manager/fromConfig.js";
import { LiveAssignmentQueue } from "./manager/liveAssignments.js";
import { ProjectFeed } from "./github/feed.js";
import { type RouteHandler, createHealthServer } from "./http.js";
import { restrictMatchmakingOrigins, verifyOrigin } from "./origins.js";
import { OfficeRoom, type OfficeRoomOptions } from "./rooms/OfficeRoom.js";
import { openOnlyOffice } from "./rooms/onlyOffice.js";
import type { IssueStates } from "./rooms/issueStateHandlers.js";

const { port, allowedOrigins, projectBoard, liveAgents, runner, manager, dataDir } = readConfig();

const projectFeed = new ProjectFeed({
  repository: projectBoard.repository,
  load: createGithubLoader({ repository: projectBoard.repository, token: projectBoard.token }),
  intervalMs: projectBoard.pollIntervalMs,
  // eslint-disable-next-line no-console -- a stale or recovered feed is an operator's business
  log: (line) => console.warn(line),
});

const liveAgentRegistry =
  liveAgents.secret === undefined
    ? undefined
    : new LiveAgentRegistry({ timeoutMs: liveAgents.timeoutMs, maxAgents: MAX_LIVE_AGENTS });

// The live agents as rooms read them: the registry's, with what the manager
// has handed each one and it has not started yet.
const liveAssignments =
  liveAgentRegistry === undefined ? undefined : new LiveAssignmentQueue({ agents: liveAgentRegistry });

const routes = new Map<string, RouteHandler>();
if (liveAgentRegistry !== undefined && liveAssignments !== undefined && liveAgents.secret !== undefined) {
  routes.set(
    LIVE_AGENT_REPORT_PATH,
    createLiveAgentEndpoint({ secret: liveAgents.secret, registry: liveAgentRegistry }),
  );
  routes.set(
    LIVE_AGENT_ASSIGNMENTS_PATH,
    createAssignmentEndpoint({ secret: liveAgents.secret, queue: liveAssignments }),
  );
}

// Slots leave after the same silence as a reported agent: both are live agents
// on the floor, and the operator sets one timeout for them.
const standingMirror = runner.secret === undefined ? undefined : new StandingMirror();
const runnerLink =
  runner.secret === undefined
    ? undefined
    : new RunnerLink({
        repository: projectBoard.repository,
        timeoutMs: liveAgents.timeoutMs,
        ...(standingMirror === undefined ? {} : { standing: standingMirror }),
        // A slot reviewing a pull request is titled from the board, which lists the open ones.
        pullTitle: (number) => projectFeed.current()?.pullRequests.find((pull) => pull.number === number)?.title,
        // The CEO's profile edits, given to a runner again after a restart of either side.
        // eslint-disable-next-line no-console -- a file the server cannot read or write is the operator's to fix
        profiles: new RunnerProfileFile({ file: join(dataDir, "agent-profiles.json"), log: (line) => console.warn(`runner link: ${line}`) }),
      });
// The slots' terminal screens, kept while the link reports each slot.
// The CEO's drops on Closed and Open go to a runner, which changes the issue
// with its own GitHub identity; the board should then show it without waiting
// for the next poll.
const issueStates: IssueStates | undefined =
  runnerLink === undefined
    ? undefined
    : {
        canChangeIssues: () => runnerLink.canChangeIssues(),
        changeIssueState: async (issueNumber: number, state: IssueState, requestedBy: string): Promise<IssueStateRejection | undefined> => {
          const rejection = await runnerLink.changeIssueState(issueNumber, state, requestedBy);
          if (rejection === undefined) {
            projectFeed.refresh();
          }
          return rejection;
        },
      };

const screens = runnerLink === undefined ? undefined : new ScreenStore({ slots: runnerLink });
if (runnerLink !== undefined && screens !== undefined && runner.secret !== undefined) {
  routes.set(RUNNER_SYNC_PATH, createRunnerEndpoint({ secret: runner.secret, link: runnerLink }));
  routes.set(RUNNER_SCREENS_PATH, createScreensEndpoint({ secret: runner.secret, store: screens }));
}

const floorSources: LiveAgentSource[] = [];
if (liveAssignments !== undefined) {
  floorSources.push(liveAssignments);
}
if (runnerLink !== undefined) {
  floorSources.push(runnerLink);
}
const floor = floorSources.length === 0 ? undefined : new CombinedLiveAgentSource(floorSources);

restrictMatchmakingOrigins(allowedOrigins);

const server = new Server({
  transport: new WebSocketTransport({
    server: createHealthServer(routes),
    verifyClient: verifyOrigin(allowedOrigins),
  }),
});

// Colyseus lets these server options win a collision with a client's join
// options, so a client can never supply the feeds or the way the manager
// thinks. The manager's advisor is made once, so its call budget is the whole
// server's.
server.define(OFFICE_ROOM_NAME, OfficeRoom, {
  projectBoard: projectFeed,
  reconnectGraceSeconds: RECONNECT_GRACE_SECONDS,
  manager: createConfiguredManager(manager),
  ...(floor === undefined ? {} : { liveAgents: floor }),
  ...(liveAssignments === undefined ? {} : { liveAssignments }),
  ...(runnerLink === undefined ? {} : { runnerEvents: runnerLink, runnerCommands: runnerLink, runnerSpend: runnerLink, runnerStandup: runnerLink }),
  agentRestrictLabel: runner.restrictLabel,
  ...(issueStates === undefined ? {} : { issueStates }),
  ...(screens === undefined ? {} : { screens }),
  ...(standingMirror === undefined ? {} : { standing: standingMirror }),
  ...(runnerLink === undefined
    ? {}
    : {
        agentHiring: {
          cap: runner.maxAgents,
          count: () => runnerLink.agentCount(),
          hire: (profile, requestedBy) => runnerLink.hire(profile, requestedBy),
          withdraw: (hire) => runnerLink.withdrawHire(hire),
        },
      }),
} satisfies OfficeRoomOptions);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    projectFeed.stop();
    liveAgentRegistry?.stop();
    liveAssignments?.stop();
    runnerLink?.stop();
    screens?.stop();
    floor?.stop();
    void server.gracefullyShutdown();
  });
}

await server.listen(port);
await openOnlyOffice();
projectFeed.start();
liveAgentRegistry?.start();
runnerLink?.start();
/* eslint-disable no-console -- the lines a developer or a platform log needs on boot */
console.log(`office server listening on port ${port} at ${TICK_RATE_HZ}Hz`);
console.log(`allowed origins: ${allowedOrigins.join(", ")}`);
console.log(
  `project board: ${projectBoard.repository} every ${projectBoard.pollIntervalMs / 1000}s, ` +
    (projectBoard.token === undefined ? "anonymous" : "with a token"),
);
console.log(describeManager(manager));
console.log(
  liveAgents.secret === undefined
    ? "live agents: off (LIVE_AGENTS_SECRET is not set)"
    : `live agents: POST ${LIVE_AGENT_REPORT_PATH}, leaving after ${liveAgents.timeoutMs / 1000}s of silence; ` +
        `assignments collected from POST ${LIVE_AGENT_ASSIGNMENTS_PATH}`,
);
console.log(
  runner.secret === undefined
    ? "runner link: off (RUNNER_SECRET is not set)"
    : `runner link: POST ${RUNNER_SYNC_PATH} for ${projectBoard.repository}, ` +
        `up to ${MAX_RUNNER_SLOTS} slots, leaving after ${liveAgents.timeoutMs / 1000}s of silence; ` +
        `the AI Manager hires up to ${runner.maxAgents} coding agents in all; ` +
        `screens on POST ${RUNNER_SCREENS_PATH}; issues with the "${runner.restrictLabel}" label are kept from agents; ` +
        `the CEO's profile edits kept in ${join(dataDir, "agent-profiles.json")}`,
);
const retiredLabel = retiredAgentIssueLabelNotice(process.env);
if (retiredLabel !== undefined) {
  console.log(retiredLabel);
}
/* eslint-enable no-console */
