/**
 * The standup in a real room over real sockets, with a real runner link and
 * the test playing the runner.
 *
 * What only a running room shows is the acceptance: only the CEO calls,
 * directs and ends a standup, and anyone else is told why; calling one, from
 * the HUD or by telling the AI Manager, gathers the agents, tells the runner a
 * standup is on and is the same in every tab, a late joiner's included; a
 * direction reaches the runner as the CEO's prompt to keep for later and its
 * fate shows in every tab; and ending it lets the runner's agents carry on.
 */

import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import {
  CLIENT_MESSAGE,
  type ManagerEntry,
  OFFICE_ROOM_NAME,
  type OfficeState,
  RUNNER_PROMPT_OUTCOME,
  type RunnerCommand,
  type RunnerPromptOutcome,
  SERVER_MESSAGE,
  STANDUP_DIRECTION_STATUS,
  STANDUP_EVERYONE,
  STANDUP_REJECTION,
  type StandupRejectedEvent,
  liveAgentKey,
} from "@sim/shared";
import { Client, type Room } from "colyseus.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { RunnerLink, runnerSlotAgentId } from "../agents/runnerLink.js";
import { createManagerAdvisor } from "../manager/advisor.js";
import { createRulePlanner } from "../manager/fromConfig.js";
import { OfficeRoom, type OfficeRoomOptions } from "./OfficeRoom.js";

const REPO = "acme/office";
const AGENT = liveAgentKey(runnerSlotAgentId("box", "slot-1"));

let server: Server;
let endpoint: string;
let link: RunnerLink;
const tabs: Tab[] = [];

/** One sync from the runner `box`, its one slot working on #39. */
function runnerSync(prompts: RunnerPromptOutcome[] = [], acked: string[] = []) {
  const outcome = link.sync({
    runnerId: "box",
    repo: REPO,
    acked,
    slots: [{ id: "slot-1", name: "Claude 1", title: "Software Developer", description: "", status: "working", issueNumber: 39, activity: "Bash: pnpm test", pr: undefined }],
    events: [],
    prompts,
  });
  if (outcome.kind !== "accepted") {
    throw new Error(`sync refused: ${outcome.kind}`);
  }
  return outcome;
}

/** Takes every command waiting for the runner, acking them so none comes again. */
function takeCommands(): RunnerCommand[] {
  const commands = runnerSync().commands;
  runnerSync([], commands.map((command) => command.id));
  return [...commands];
}

beforeAll(async () => {
  link = new RunnerLink({ repository: REPO, timeoutMs: 60_000 });
  runnerSync();
  server = new Server({ transport: new WebSocketTransport(), greet: false });
  server.define(OFFICE_ROOM_NAME, OfficeRoom, {
    liveAgents: link,
    runnerEvents: link,
    runnerCommands: link,
    runnerStandup: link,
    manager: createManagerAdvisor({ planner: createRulePlanner(0), mode: "rules" }),
  } satisfies Partial<OfficeRoomOptions>);
  await server.listen(0);
  const address = server.transport.server?.address();
  if (address === null || address === undefined || typeof address === "string") {
    throw new Error("the transport did not bind a TCP port");
  }
  endpoint = `ws://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await Promise.all(tabs.splice(0).map((tab) => tab.room.leave()));
  takeCommands();
});

afterAll(async () => {
  link.stop();
  await server.gracefullyShutdown(false);
});

interface Tab {
  readonly room: Room<OfficeState>;
  readonly rejections: StandupRejectedEvent[];
  readonly conversation: ManagerEntry[];
}

function listen(room: Room<OfficeState>): Tab {
  const tab: Tab = { room, rejections: [], conversation: [] };
  room.onMessage("*", () => undefined);
  room.onMessage<StandupRejectedEvent>(SERVER_MESSAGE.standupRejected, (event) => {
    tab.rejections.push(event);
  });
  room.onMessage<ManagerEntry>(SERVER_MESSAGE.managerEntry, (entry) => {
    tab.conversation.push(entry);
  });
  tabs.push(tab);
  return tab;
}

async function openOffice(): Promise<{ dana: Tab; milo: Tab }> {
  const dana = listen(await new Client(endpoint).create<OfficeState>(OFFICE_ROOM_NAME, { name: "Dana" }));
  const milo = listen(await new Client(endpoint).joinById<OfficeState>(dana.room.roomId, { name: "Milo" }));
  await settled(() => dana.room.state.occupants?.has(milo.room.sessionId) === true);
  await settled(() => milo.room.state.occupants?.has(AGENT) === true);
  return { dana, milo };
}

async function settled(ready: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the room");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("the standup in a live room", () => {
  it("is called by the CEO alone, the same in every tab, and tells the runner", async () => {
    const { dana, milo } = await openOffice();
    milo.room.send(CLIENT_MESSAGE.standupStart, {});
    await settled(() => milo.rejections.length === 1);
    expect(milo.rejections).toEqual([{ command: CLIENT_MESSAGE.standupStart, rejection: STANDUP_REJECTION.forbidden }]);
    expect(dana.room.state.standup.active).toBe(false);
    expect(runnerSync().standup).toBe(false);

    dana.room.send(CLIENT_MESSAGE.standupStart, {});
    await settled(() => milo.room.state.standup.active);
    for (const tab of [dana, milo]) {
      expect(tab.room.state.standup).toMatchObject({ active: true, calledBy: "Dana" });
      expect(tab.room.state.standup.order.toArray()).toEqual([AGENT]);
    }
    expect(runnerSync().standup).toBe(true);
    expect(dana.rejections).toEqual([]);

    dana.room.send(CLIENT_MESSAGE.standupStart, {});
    await settled(() => dana.rejections.length === 1);
    expect(dana.rejections).toEqual([{ command: CLIENT_MESSAGE.standupStart, rejection: STANDUP_REJECTION.running }]);

    milo.room.send(CLIENT_MESSAGE.standupEnd, {});
    await settled(() => milo.rejections.length === 2);
    expect(milo.rejections.at(-1)).toEqual({ command: CLIENT_MESSAGE.standupEnd, rejection: STANDUP_REJECTION.forbidden });

    dana.room.send(CLIENT_MESSAGE.standupEnd, {});
    await settled(() => !milo.room.state.standup.active);
    expect(runnerSync().standup).toBe(false);
  });

  it("shows a tab that joins in the middle of one the same meeting", async () => {
    const { dana } = await openOffice();
    dana.room.send(CLIENT_MESSAGE.standupStart, {});
    await settled(() => dana.room.state.standup.active);
    dana.room.send(CLIENT_MESSAGE.standupDirect, { agentId: AGENT, text: "Open the PR." });
    await settled(() => dana.room.state.standup.directions.length === 1);

    const late = listen(await new Client(endpoint).joinById<OfficeState>(dana.room.roomId, { name: "Ada" }));
    await settled(() => late.room.state.standup?.directions?.length === 1);
    expect(late.room.state.standup).toMatchObject({ active: true, calledBy: "Dana" });
    expect(late.room.state.standup.directions.at(0)).toMatchObject({ agentName: "Claude 1", text: "Open the PR." });
    dana.room.send(CLIENT_MESSAGE.standupEnd, {});
    await settled(() => !late.room.state.standup.active);
  });

  it("passes a direction to the runner as the CEO's prompt to keep, and shows every tab what came of it", async () => {
    const { dana, milo } = await openOffice();
    dana.room.send(CLIENT_MESSAGE.standupStart, {});
    await settled(() => dana.room.state.standup.active);

    milo.room.send(CLIENT_MESSAGE.standupDirect, { agentId: STANDUP_EVERYONE, text: "Stop." });
    await settled(() => milo.rejections.length === 1);
    expect(milo.rejections).toEqual([{ command: CLIENT_MESSAGE.standupDirect, rejection: STANDUP_REJECTION.forbidden }]);

    dana.room.send(CLIENT_MESSAGE.standupDirect, { agentId: STANDUP_EVERYONE, text: "Skip the server part\u001b[2J and open the PR." });
    await settled(() => milo.room.state.standup.directions.length === 1);
    const [command] = takeCommands().filter((candidate) => candidate.kind === "prompt");
    expect(command).toMatchObject({
      kind: "prompt",
      slotId: "slot-1",
      text: "Skip the server part[2J and open the PR.",
      requestedBy: "Dana",
      fromCeo: true,
      queue: true,
    });

    runnerSync([{ commandId: command?.id ?? "", slotId: "slot-1", outcome: RUNNER_PROMPT_OUTCOME.queued }]);
    await settled(() => milo.room.state.standup.directions.at(0)?.status === STANDUP_DIRECTION_STATUS.queued);

    dana.room.send(CLIENT_MESSAGE.standupEnd, {});
    await settled(() => !milo.room.state.standup.active);
    runnerSync([{ commandId: command?.id ?? "", slotId: "slot-1", outcome: RUNNER_PROMPT_OUTCOME.delivered }]);
    await settled(() => milo.room.state.standup.directions.at(0)?.status === STANDUP_DIRECTION_STATUS.delivered);
  });

  it("is called and ended by telling the AI Manager, which says how it went", async () => {
    const { dana, milo } = await openOffice();
    dana.room.send(CLIENT_MESSAGE.managerSay, { text: "Call a standup" });
    await settled(() => milo.room.state.standup.active);
    await settled(() => milo.conversation.some((entry) => entry.text.includes("✓ Standup called")));
    expect(milo.conversation.at(-1)?.text).toBe(
      "Calling a standup: everyone to my desk, and each of them gives an update in turn.\n✓ Standup called: one agent on the way to my desk.",
    );

    milo.room.send(CLIENT_MESSAGE.managerSay, { text: "end the standup" });
    dana.room.send(CLIENT_MESSAGE.managerSay, { text: "The standup's over" });
    await settled(() => !milo.room.state.standup.active);
  });
});
