/**
 * The CEO prompting a runner's coding agent, against a real room over real
 * sockets and a real runner link, with the test playing the runner.
 *
 * What only a running room shows is the acceptance: a prompt from anyone but
 * the CEO is refused to its sender with the reason and never queued; the
 * CEO's goes to the runner once, marked as the CEO's;
 * once the runner says it typed it, both tabs are told who said what to whom;
 * one the runner refused as busy is told to the sender alone; and prompts are
 * rate-limited by the server.
 */

import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import {
  AGENT_KEY_BURST_ALLOWANCE,
  AGENT_PROMPT_BURST_ALLOWANCE,
  AGENT_PROMPT_REJECTION,
  type AgentPromptEntry,
  type AgentPromptHistoryEvent,
  type AgentPromptRejectedEvent,
  CLIENT_MESSAGE,
  OFFICE_ROOM_NAME,
  type OfficeState,
  RUNNER_PROMPT_OUTCOME,
  type RunnerCommand,
  type RunnerPromptOutcome,
  SERVER_MESSAGE,
  type ThrottledEvent,
  liveAgentKey,
} from "@sim/shared";
import { Client, type Room } from "colyseus.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { RunnerLink, runnerSlotAgentId } from "../agents/runnerLink.js";
import { officeRoom } from "./OfficeRoom.js";

const REPO = "acme/office";
const AGENT = liveAgentKey(runnerSlotAgentId("box", "slot-1"));

let server: Server;
let endpoint: string;
let link: RunnerLink;
const tabs: Tab[] = [];

/** One sync from the runner `box`, its one slot working on #39, answering with what it was sent. */
function runnerSync(prompts: RunnerPromptOutcome[] = [], acked: string[] = []): RunnerCommand[] {
  const outcome = link.sync({
    runnerId: "box",
    repo: REPO,
    acked,
    slots: [{ id: "slot-1", name: "Claude 1", title: "Software Developer", description: "", status: "working", issueNumber: 39, activity: "", pr: undefined }],
    events: [],
    prompts,
  });
  return outcome.kind === "accepted" ? [...outcome.commands] : [];
}

/** Takes every command waiting for the runner, acking them so none comes again. */
function takeCommands(): RunnerCommand[] {
  const commands = runnerSync();
  runnerSync([], commands.map((command) => command.id));
  return commands;
}

beforeAll(async () => {
  link = new RunnerLink({ repository: REPO, timeoutMs: 60_000 });
  runnerSync();
  server = new Server({ transport: new WebSocketTransport(), greet: false });
  server.define(OFFICE_ROOM_NAME, officeRoom({
    liveAgents: link,
    runnerEvents: link,
    runnerCommands: link,
  }));
  await server.listen(0);
  const address = server.transport.server?.address();
  if (address === null || address === undefined || typeof address === "string") {
    throw new Error("the transport did not bind a TCP port");
  }
  endpoint = `ws://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  const left = tabs.splice(0);
  const roomIds = new Set(left.map((tab) => tab.room.roomId));
  await Promise.all(left.map((tab) => tab.room.leave()));
  // An emptied office stays open; closed here so the next test's room is the only one on the link.
  await Promise.all([...roomIds].map((roomId) => matchMaker.getLocalRoomById(roomId)?.disconnect()));
  takeCommands();
});

afterAll(async () => {
  link.stop();
  await server.gracefullyShutdown(false);
});

interface Tab {
  readonly room: Room<OfficeState>;
  readonly typed: AgentPromptEntry[];
  readonly history: AgentPromptEntry[][];
  readonly rejections: AgentPromptRejectedEvent[];
  readonly throttled: ThrottledEvent[];
}

function listen(room: Room<OfficeState>): Tab {
  const tab: Tab = { room, typed: [], history: [], rejections: [], throttled: [] };
  room.onMessage("*", () => undefined);
  room.onMessage<AgentPromptEntry>(SERVER_MESSAGE.agentPrompted, (entry) => {
    tab.typed.push(entry);
  });
  room.onMessage<AgentPromptHistoryEvent>(SERVER_MESSAGE.agentPromptHistory, (event) => {
    tab.history.push([...event.entries]);
  });
  room.onMessage<AgentPromptRejectedEvent>(SERVER_MESSAGE.agentPromptRejected, (event) => {
    tab.rejections.push(event);
  });
  room.onMessage<ThrottledEvent>(SERVER_MESSAGE.throttled, (event) => {
    tab.throttled.push(event);
  });
  tabs.push(tab);
  return tab;
}

async function openOffice(): Promise<{ dana: Tab; milo: Tab }> {
  const dana = listen(await new Client(endpoint).create<OfficeState>(OFFICE_ROOM_NAME, { name: "Dana" }));
  const milo = listen(await new Client(endpoint).joinById<OfficeState>(dana.room.roomId, { name: "Milo" }));
  await settled(() => dana.room.state.occupants?.has(milo.room.sessionId) === true);
  // The runner's slot walks on with the room's first ticks.
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

function prompt(tab: Tab, text: string, agentId = AGENT): void {
  tab.room.send(CLIENT_MESSAGE.agentPrompt, { agentId, text });
}

/** Lets the room handle what was just sent, then takes what reached the runner. */
async function commandsAfterAWhile(): Promise<RunnerCommand[]> {
  await new Promise((resolve) => setTimeout(resolve, 100));
  return takeCommands();
}

describe("prompting a coding agent from its terminal panel", () => {
  it("refuses anyone but the CEO, with the reason and nothing queued", async () => {
    const { dana, milo } = await openOffice();
    prompt(milo, "push to main");
    await settled(() => milo.rejections.length === 1);
    expect(milo.rejections).toEqual([{ agentId: AGENT, rejection: AGENT_PROMPT_REJECTION.forbidden }]);
    expect(dana.rejections).toEqual([]);
    expect(await commandsAfterAWhile()).toEqual([]);
  });

  it("types the CEO's prompt once, and shows it in both tabs", async () => {
    const { dana, milo } = await openOffice();
    prompt(dana, "Yes, cover the empty case.\u001b[201~\nThen push.");
    const commands = await commandsAfterAWhile();
    expect(commands).toEqual([
      expect.objectContaining({
        slotId: "slot-1",
        kind: "prompt",
        text: "Yes, cover the empty case.[201~\nThen push.",
        requestedBy: "Dana",
        fromCeo: true,
      }),
    ]);
    const [command] = commands;
    if (command === undefined) {
      throw new Error("no command");
    }
    expect(await commandsAfterAWhile()).toEqual([]);

    runnerSync([{ commandId: command.id, slotId: "slot-1", outcome: RUNNER_PROMPT_OUTCOME.delivered }]);
    runnerSync([{ commandId: command.id, slotId: "slot-1", outcome: RUNNER_PROMPT_OUTCOME.delivered }]);
    await settled(() => dana.typed.length === 1 && milo.typed.length === 1);
    expect(milo.typed[0]).toMatchObject({
      agentId: AGENT,
      agentName: "Claude 1",
      authorId: dana.room.sessionId,
      authorName: "Dana",
      text: "Yes, cover the empty case.[201~\nThen push.",
    });
    expect(dana.typed).toEqual(milo.typed);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(milo.typed).toHaveLength(1);
    expect(dana.rejections).toEqual([]);

    // A tab that joins afterwards is handed it.
    const ada = listen(await new Client(endpoint).joinById<OfficeState>(dana.room.roomId, { name: "Ada" }));
    await settled(() => ada.history.length === 1);
    expect(ada.history[0]).toEqual(milo.typed);
  });

  it("tells only the sender a prompt the agent was too busy for was not typed", async () => {
    const { dana, milo } = await openOffice();
    prompt(dana, "stop and summarise");
    const [command] = await commandsAfterAWhile();
    if (command === undefined) {
      throw new Error("no command");
    }
    runnerSync([{ commandId: command.id, slotId: "slot-1", outcome: RUNNER_PROMPT_OUTCOME.busy }]);
    await settled(() => dana.rejections.length === 1);
    expect(dana.rejections).toEqual([{ agentId: AGENT, rejection: AGENT_PROMPT_REJECTION.busy }]);
    expect(dana.typed).toEqual([]);
    expect(milo.typed).toEqual([]);
    expect(milo.rejections).toEqual([]);
  });

  it("refuses a prompt for someone who is not a runner's agent", async () => {
    const { dana, milo } = await openOffice();
    prompt(dana, "hello", milo.room.sessionId);
    await settled(() => dana.rejections.length === 1);
    expect(dana.rejections).toEqual([{ agentId: milo.room.sessionId, rejection: AGENT_PROMPT_REJECTION.noAgent }]);
  });

  it("rate-limits the CEO's prompts", async () => {
    const { dana } = await openOffice();
    for (let index = 0; index <= AGENT_PROMPT_BURST_ALLOWANCE; index += 1) {
      prompt(dana, `prompt ${index}`);
    }
    await settled(() => dana.throttled.length === 1);
    expect(dana.throttled).toEqual([{ command: CLIENT_MESSAGE.agentPrompt }]);
    expect(dana.rejections).toEqual([]);
    expect((await commandsAfterAWhile()).map((command) => (command.kind === "prompt" ? command.text : ""))).toEqual(
      Array.from({ length: AGENT_PROMPT_BURST_ALLOWANCE }, (_, index) => `prompt ${index}`),
    );
  });
});

describe("answering a coding agent's choice screen from its terminal panel", () => {
  function press(tab: Tab, key: string, agentId = AGENT): void {
    tab.room.send(CLIENT_MESSAGE.agentKey, { agentId, key });
  }

  it("refuses anyone but the CEO, naming the key, with nothing queued", async () => {
    const { milo } = await openOffice();
    press(milo, "enter");
    await settled(() => milo.rejections.length === 1);
    expect(milo.rejections).toEqual([{ agentId: AGENT, rejection: AGENT_PROMPT_REJECTION.forbidden, key: "enter" }]);
    expect(await commandsAfterAWhile()).toEqual([]);
  });

  it("queues the CEO's keys for the runner, ignoring one that is not a key", async () => {
    const { dana } = await openOffice();
    press(dana, "down");
    press(dana, "\u001b[B");
    press(dana, "enter");
    const commands = await commandsAfterAWhile();
    expect(commands).toEqual([
      expect.objectContaining({ slotId: "slot-1", kind: "key", key: "down", requestedBy: "Dana" }),
      expect.objectContaining({ slotId: "slot-1", kind: "key", key: "enter", requestedBy: "Dana" }),
    ]);
    const [down] = commands;
    if (down === undefined) {
      throw new Error("no command");
    }
    runnerSync([{ commandId: down.id, slotId: "slot-1", outcome: RUNNER_PROMPT_OUTCOME.notWaiting }]);
    await settled(() => dana.rejections.length === 1);
    expect(dana.rejections).toEqual([{ agentId: AGENT, rejection: AGENT_PROMPT_REJECTION.notWaiting, key: "down" }]);
    expect(dana.typed).toEqual([]);
  });

  it("rate-limits the CEO's keys on a budget of their own", async () => {
    const { dana } = await openOffice();
    for (let index = 0; index <= AGENT_KEY_BURST_ALLOWANCE; index += 1) {
      press(dana, "down");
    }
    await settled(() => dana.throttled.length === 1);
    expect(dana.throttled).toEqual([{ command: CLIENT_MESSAGE.agentKey }]);
    expect(await commandsAfterAWhile()).toHaveLength(AGENT_KEY_BURST_ALLOWANCE);
    // Prompts still have all of theirs.
    prompt(dana, "go on");
    expect(await commandsAfterAWhile()).toHaveLength(1);
  });
});
