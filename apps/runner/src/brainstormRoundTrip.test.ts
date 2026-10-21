/**
 * A brainstorm ticket end to end, over real HTTP: the server's brainstorms
 * and runner link against a mock runner's slot pool, sync loop and brainstorm
 * desk, with `gh` stood in for. The CEO hands an idea to two agents; each
 * researches it with no worktree, the write-ups ride the syncs one at a time,
 * one agent merges them, the design document is posted on the issue, and a
 * player's conversion creates the issues and closes the idea.
 */

import type { AddressInfo } from "node:net";

import {
  BRAINSTORM_ACTION,
  BRAINSTORM_MODE,
  BRAINSTORM_STATUS,
  type BrainstormData,
  EMPTY_BOARD_LISTS,
  HumanPlayer,
  LiveAgent,
  OCCUPANT_KIND,
  OFFICE_LAYOUT,
  OfficeState,
  PLAYER_ROLE,
  RUNNER_SYNC_PATH,
  designDocument,
  liveAgentKey,
  workKey,
} from "@sim/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Brainstorms } from "../../server/src/agents/brainstorms.js";
import { createRunnerEndpoint } from "../../server/src/agents/runnerEndpoint.js";
import { RunnerLink, runnerSlotAgentId } from "../../server/src/agents/runnerLink.js";
import { createHealthServer } from "../../server/src/http.js";
import { createMockAgent } from "./agents/mock.js";
import { createMockBrainstormer } from "./agents/brainstorm.js";
import { BrainstormDesk, ghBrainstorm } from "./brainstormDesk.js";
import type { RunCommand } from "./github.js";
import { SlotPool } from "./slots.js";
import { createSyncClient } from "./syncClient.js";
import { SyncLoop } from "./syncLoop.js";

const SECRET = "a-runner-secret-long-enough";
const REPO = "krasovsky22/agent-office-sims";

const link = new RunnerLink({ repository: REPO, timeoutMs: 60_000 });
const server = createHealthServer(new Map([[RUNNER_SYNC_PATH, createRunnerEndpoint({ secret: SECRET, link })]]));
let serverUrl: URL;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  serverUrl = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("a brainstorm ticket between the server and a mock runner", () => {
  it("is researched with no worktree, merged, posted, and converted into issues", async () => {
    const state = new OfficeState();
    const dana = Object.assign(new HumanPlayer(), { id: "dana", name: "Dana", role: PLAYER_ROLE.ceo });
    const milo = Object.assign(new HumanPlayer(), { id: "milo", name: "Milo", role: PLAYER_ROLE.exec });
    state.occupants.set(dana.id, dana);
    state.occupants.set(milo.id, milo);
    const agents = ["slot-1", "slot-2"].map((slotId) => liveAgentKey(runnerSlotAgentId("runner-1", slotId)));
    for (const [index, id] of agents.entries()) {
      // As the crew puts a runner's slot on the floor.
      state.occupants.set(id, Object.assign(new LiveAgent(), { id, name: `Agent ${index + 1}`, kind: OCCUPANT_KIND.liveAgent, canTakeIssues: true }));
    }
    const board = {
      ...EMPTY_BOARD_LISTS,
      repository: REPO,
      updatedAt: 1,
      stale: false,
      open: [{ number: 191, title: "Idea tasks", body: "", labels: [{ name: "brainstorm", color: "" }], assignees: [], pullRequests: [], closedAt: null }],
    };
    const brainstorms = new Brainstorms({
      state,
      layout: OFFICE_LAYOUT,
      board: () => board,
      runner: link,
      github: link,
      crew: { gather: () => undefined, dismiss: () => undefined, isGathered: () => true },
      standupOn: () => false,
      say: () => undefined,
      announce: () => undefined,
      now: () => Date.now(),
      clock: () => Date.now(),
    });
    const inbox = link.openEventInbox();

    const opened: string[] = [];
    const gh: string[][] = [];
    let issue = 200;
    const run: RunCommand = async (_file, args) => {
      gh.push([...args]);
      return args[1] === "create" ? `https://github.com/${REPO}/issues/${issue++}` : "";
    };
    let nextId = 1;
    const pool = new SlotPool({
      count: 2,
      agent: createMockAgent({ outcome: "pr-opened", stepMs: 10 }),
      workspaces: {
        open: async (slotId) => {
          opened.push(slotId);
          return "/nowhere";
        },
        close: async () => undefined,
      },
      taskTimeoutMs: 60_000,
      runnerId: "runner-1",
      brainstormer: createMockBrainstormer(10),
      eventId: () => `event-${nextId++}`,
    });
    const loop = new SyncLoop({
      runnerId: "runner-1",
      repo: REPO,
      pool,
      // A runner that writes to GitHub: the issue desk's presence is what says so.
      issues: { handle: async () => undefined, pending: () => [], delivered: () => undefined },
      brainstorms: new BrainstormDesk({ github: ghBrainstorm({ repo: REPO, env: async () => ({}), run }), eventId: () => `event-${nextId++}` }),
      client: createSyncClient({ serverUrl, secret: SECRET }),
    });
    const idea = () => state.brainstorms.get(workKey(191));
    const syncUntil = async (done: () => boolean) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        expect(await loop.syncOnce()).toBe(true);
        brainstorms.receive(inbox.drain());
        if (done()) {
          return;
        }
        // As fast as the route's rate limit refills.
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`the idea never got there: ${idea()?.status} ${JSON.stringify(idea()?.toJSON())}`);
    };

    await loop.syncOnce();
    expect(brainstorms.assign(dana, { issueNumber: 191, agentIds: agents, mode: BRAINSTORM_MODE.takes })).toBeUndefined();
    await syncUntil(() => idea()?.postStatus === "done");

    const data = idea()?.toJSON() as BrainstormData;
    expect(data.status).toBe(BRAINSTORM_STATUS.ready);
    expect(data.takes.map((take) => [take.status, take.verdict])).toEqual([
      ["done", "doable with caveats"],
      ["done", "doable with caveats"],
    ]);
    expect(data.synthesis).toContain("**Recommended features**");
    // Research opened no worktree, so no branch to commit on and no pull request.
    expect(opened).toEqual([]);
    expect(gh[0]?.slice(0, 3)).toEqual(["issue", "comment", "191"]);
    expect(gh[0]?.[gh[0].indexOf("--body") + 1]).toBe(`${designDocument(data)}\n\n_Posted from the office by its agent runner for Dana._`);

    expect(brainstorms.act(milo, BRAINSTORM_ACTION.review, 191)).toBeUndefined();
    expect(brainstorms.convert(milo, { issueNumber: 191, drafts: [{ title: "Ideas on the board", body: "Build it." }, { title: "The meeting", body: "Then this." }] })).toBeUndefined();
    await syncUntil(() => idea()?.status === BRAINSTORM_STATUS.converted);
    expect((idea()?.toJSON() as BrainstormData).created).toEqual([
      { number: 200, url: `https://github.com/${REPO}/issues/200` },
      { number: 201, url: `https://github.com/${REPO}/issues/201` },
    ]);
    expect(gh.at(-1)?.slice(0, 3)).toEqual(["issue", "close", "191"]);
    inbox.close();
  });
});
