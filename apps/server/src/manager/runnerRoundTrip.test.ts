/**
 * The AI Manager and the runner's coding agents, end to end: a live room, the
 * runner link over real HTTP, and the runner's own slot pool with the mock
 * agent, so what the CEO reads in the conversation at each step is what the
 * office would say about a real agent's work.
 *
 * Both slots' mocks stop to wait on the CEO, and wait until the CEO answers
 * them from their terminal panels; then one hands in a simulated pull request
 * and the other fails, so both endings are heard. The runner's modules are imported
 * from its source, as the runner's own round trip imports the server's;
 * nothing here reaches GitHub.
 */

import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import {
  type AgentPromptEntry,
  type AgentPromptRejectedEvent,
  type BoardIssue,
  CLIENT_MESSAGE,
  EMPTY_BOARD_LISTS,
  MANAGER_ENTRY_KIND,
  type ManagerEntry,
  OFFICE_ROOM_NAME,
  type OfficeState,
  type ProjectBoardSnapshot,
  RUNNER_SYNC_PATH,
  SERVER_MESSAGE,
  defaultAgentName,
  isLiveAgent,
  liveAgentKey,
} from "@sim/shared";
import { Client, type Room } from "colyseus.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMockAgent } from "../../../runner/src/agents/mock.js";
import type { Agent } from "../../../runner/src/agents/types.js";
import { type GitFixture, gitFixture } from "../../../runner/src/gitFixture.js";
import { SlotWorktrees } from "../../../runner/src/slotWorktrees.js";
import { SlotPool } from "../../../runner/src/slots.js";
import { createSyncClient } from "../../../runner/src/syncClient.js";
import { SyncLoop } from "../../../runner/src/syncLoop.js";
import { Worktrees } from "../../../runner/src/worktrees.js";
import { createRunnerEndpoint } from "../agents/runnerEndpoint.js";
import { RunnerLink, runnerSlotAgentId } from "../agents/runnerLink.js";
import { createHealthServer } from "../http.js";
import { OfficeRoom, type OfficeRoomOptions } from "../rooms/OfficeRoom.js";
import { createManagerAdvisor } from "./advisor.js";
import { createRulePlanner } from "./fromConfig.js";

const REPO = "acme/office";
const SECRET = "a-runner-secret-long-enough";
/** Between one mock step and the next. */
const STEP_MS = 500;
/** Between one sync and the next, as fast as the runner route's rate limit refills. */
const SYNC_GAP_MS = 100;

function issue(number: number, title: string, ...labels: string[]): BoardIssue {
  return {
    number,
    title,
    body: "",
    labels: labels.map((name) => ({ name, color: "" })),
    assignees: [],
    pullRequests: [],
    closedAt: null,
  };
}

const BOARD: ProjectBoardSnapshot = {
  ...EMPTY_BOARD_LISTS,
  repository: REPO,
  updatedAt: 1,
  stale: false,
  open: [issue(39, "Night shift"), issue(40, "Fix the login redirect loop", "agent-restricted"), issue(41, "Draft the roadmap")],
  counts: { open: 3, inProgress: 0, pullRequests: 0 },
};

const link = new RunnerLink({ repository: REPO, timeoutMs: 60_000 });
const http = createHealthServer(new Map([[RUNNER_SYNC_PATH, createRunnerEndpoint({ secret: SECRET, link })]]));
let server: Server;
let endpoint: string;
let fixture: GitFixture;
let syncing = true;
let syncs: Promise<void> | undefined;

/** The mock opening a pull request for #39, and failing anything else. */
function mockAgent(): Agent {
  const opens = createMockAgent({ outcome: "pr-opened", stepMs: STEP_MS });
  const fails = createMockAgent({ outcome: "failed", stepMs: STEP_MS });
  return { label: opens.label, start: (task, reporter) => (task.issueNumber === 39 ? opens : fails).start(task, reporter) };
}

beforeAll(async () => {
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const serverUrl = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}`);

  server = new Server({ transport: new WebSocketTransport(), greet: false });
  server.define(OFFICE_ROOM_NAME, OfficeRoom, {
    projectBoard: { current: () => BOARD, subscribe: () => () => undefined },
    manager: createManagerAdvisor({ planner: createRulePlanner(0), mode: "rules" }),
    liveAgents: link,
    runnerEvents: link,
    runnerCommands: link,
    agentRestrictLabel: "agent-restricted",
  } satisfies Partial<OfficeRoomOptions>);
  await server.listen(0);
  const address = server.transport.server?.address();
  if (address === null || address === undefined || typeof address === "string") {
    throw new Error("the transport did not bind a TCP port");
  }
  endpoint = `ws://127.0.0.1:${address.port}`;

  fixture = gitFixture();
  const workspaces = new SlotWorktrees({
    worktrees: new Worktrees({
      repoDir: join(fixture.dataDir, "repo"),
      worktreesDir: join(fixture.dataDir, "worktrees"),
      clone: fixture.clone,
    }),
    stateFile: join(fixture.dataDir, "worktrees.json"),
  });
  await workspaces.reattach();
  const loop = new SyncLoop({
    runnerId: "runner-1",
    repo: REPO,
    pool: new SlotPool({ count: 2, agent: mockAgent(), workspaces, taskTimeoutMs: 60_000, runnerId: "runner-1" }),
    client: createSyncClient({ serverUrl, secret: SECRET }),
  });
  syncs = (async () => {
    while (syncing) {
      await loop.syncOnce();
      await new Promise((resolve) => setTimeout(resolve, SYNC_GAP_MS));
    }
  })();
});

afterAll(async () => {
  syncing = false;
  await syncs;
  await server.gracefullyShutdown(false);
  await new Promise((resolve) => http.close(resolve));
  fixture.cleanup();
});

interface Tab {
  readonly room: Room<OfficeState>;
  readonly entries: ManagerEntry[];
}

async function settled(ready: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the office");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function serverRoom(tab: Tab): OfficeRoom {
  return matchMaker.getLocalRoomById(tab.room.roomId) as OfficeRoom;
}

function lines(tab: Tab, kind: ManagerEntry["kind"]): string[] {
  return tab.entries.filter((entry) => entry.kind === kind).map((entry) => entry.text);
}

/** Says something to the AI Manager and waits for the reply to it. */
async function ask(tab: Tab, text: string): Promise<string> {
  const before = lines(tab, MANAGER_ENTRY_KIND.reply).length;
  tab.room.send(CLIENT_MESSAGE.managerSay, { text });
  await settled(() => lines(tab, MANAGER_ENTRY_KIND.reply).length > before);
  return lines(tab, MANAGER_ENTRY_KIND.reply)[before] ?? "";
}

/** The AI Manager's updates about one agent, in order. */
function updatesAbout(tab: Tab, name: string): string[] {
  return lines(tab, MANAGER_ENTRY_KIND.update)
    .flatMap((text) => text.split("\n"))
    .filter((line) => line.startsWith(`${name} `));
}

/** The runner's agents' default names, as its runner id gives them. */
const FIRST = defaultAgentName("runner-1", 0);
const SECOND = defaultAgentName("runner-1", 1);

describe("the AI Manager and the mock runner's coding agents", () => {
  it("puts a free coding agent on an issue however it is asked for, and says how it goes at each step", { timeout: 60_000 }, async () => {
    const room = await new Client(endpoint).create<OfficeState>(OFFICE_ROOM_NAME, { name: "Dana" });
    const dana: Tab = { room, entries: [] };
    room.onMessage<ManagerEntry>(SERVER_MESSAGE.managerEntry, (entry) => dana.entries.push(entry));
    const typed: AgentPromptEntry[] = [];
    const rejected: AgentPromptRejectedEvent[] = [];
    room.onMessage<AgentPromptEntry>(SERVER_MESSAGE.agentPrompted, (entry) => typed.push(entry));
    room.onMessage<AgentPromptRejectedEvent>(SERVER_MESSAGE.agentPromptRejected, (event) => rejected.push(event));
    for (const ignored of [
      SERVER_MESSAGE.managerHistory,
      SERVER_MESSAGE.projectBoard,
      SERVER_MESSAGE.ceoChanged,
      SERVER_MESSAGE.chat,
      SERVER_MESSAGE.screens,
      SERVER_MESSAGE.agentPromptHistory,
    ]) {
      room.onMessage(ignored, () => undefined);
    }
    await settled(() => [...serverRoom(dana).state.occupants.values()].filter(isLiveAgent).length === 2);

    // "Someone" is a coding agent too, and the work rules still decide what one may be given.
    expect(await ask(dana, "put someone on #40")).toBe(
      "Here's how that went:\n✗ #40 “Fix the login redirect loop”: it carries the label that keeps the coding agents off it.",
    );
    expect(serverRoom(dana).state.work.size).toBe(0);

    expect(await ask(dana, "assign the night shift ticket")).toBe(`Here's how that went:\n✓ #39 “Night shift” → ${FIRST}.`);
    expect(await ask(dana, `have ${SECOND} do #41`)).toBe(`Here's how that went:\n✓ #41 “Draft the roadmap” → ${SECOND}.`);

    // Both stop to wait on the CEO, and wait for as long as nobody answers.
    const waiting = (name: string, number: number) => `${name} needs you on #${number}: Permission: Bash pnpm test`;
    await settled(() => updatesAbout(dana, FIRST).includes(waiting(FIRST, 39)) && updatesAbout(dana, SECOND).includes(waiting(SECOND, 41)), 20_000);
    // Twenty of its steps, long enough too for the CEO's message allowance to refill.
    await new Promise((resolve) => setTimeout(resolve, STEP_MS * 20));
    expect(await ask(dana, `what is ${FIRST} doing?`)).toBe(
      `${FIRST} (coding agent) is waiting on you on #39 “Night shift” (Permission: Bash pnpm test).`,
    );
    expect(serverRoom(dana).state.work.get("39")?.status).toBe("in_progress");

    // The CEO answers each from its terminal panel, and that carries it on.
    for (const slotId of ["slot-1", "slot-2"]) {
      room.send(CLIENT_MESSAGE.agentPrompt, { agentId: liveAgentKey(runnerSlotAgentId("runner-1", slotId)), text: "Go ahead." });
    }
    await settled(() => typed.length === 2, 10_000);
    expect(typed.map((entry) => [entry.agentName, entry.text])).toEqual([
      [FIRST, "Go ahead."],
      [SECOND, "Go ahead."],
    ]);
    expect(rejected).toEqual([]);
    const opened = `${FIRST} handed in #39 “Night shift” for your review as a simulated pull request: the mock agent opened nothing on GitHub.`;
    const failed =
      `${SECOND} couldn't work on #41 “Draft the roadmap”: The mock agent always fails; set RUNNER_MOCK_OUTCOME=pr-opened for a simulated pull request.`;
    await settled(() => updatesAbout(dana, FIRST).includes(opened) && updatesAbout(dana, SECOND).includes(failed), 20_000);
    expect(updatesAbout(dana, FIRST)).toEqual([
      `${FIRST} started on #39 “Night shift”.`,
      `${FIRST} needs you on #39: Permission: Bash pnpm test`,
      opened,
    ]);
    expect(updatesAbout(dana, SECOND)).toEqual([
      `${SECOND} started on #41 “Draft the roadmap”.`,
      `${SECOND} needs you on #41: Permission: Bash pnpm test`,
      failed,
    ]);

    expect(await ask(dana, `what is ${FIRST} doing?`)).toBe(
      `${FIRST} (coding agent) handed in #39 “Night shift” as a simulated pull request, with nothing on GitHub; it is waiting for your review.`,
    );
    expect(serverRoom(dana).state.work.get("39")?.outputArtifact).toBe("Simulated pull request, nothing on GitHub: [mock] Night shift");
    // Nowhere does the office name or link a pull request that does not exist.
    expect(JSON.stringify(dana.entries)).not.toMatch(/1000039|\/pull\//);
    expect(await ask(dana, `what is ${SECOND} doing?`)).toBe(
      `${SECOND} (coding agent) has #41 “Draft the roadmap” in progress but isn't running. Its last word on it: The mock agent always fails; set RUNNER_MOCK_OUTCOME=pr-opened for a simulated pull request.`,
    );
    await room.leave();
  });
});
