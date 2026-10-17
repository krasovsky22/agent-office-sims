/**
 * The CEO prompting a runner's coding agent, against a real room over real
 * sockets and a real runner link, with the test playing the runner.
 *
 * What only a running room shows is the acceptance: a prompt from anyone but
 * a verified operator-CEO is refused to its sender with the reason and never
 * queued; the operator-CEO's goes to the runner once, marked as the CEO's;
 * once the runner says it typed it, both tabs are told who said what to whom;
 * one the runner refused as busy is told to the sender alone; and prompts are
 * rate-limited by the server.
 */

import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import {
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
  isOperator,
  liveAgentKey,
} from "@sim/shared";
import { Client, type Room } from "colyseus.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { RunnerLink, runnerSlotAgentId } from "../agents/runnerLink.js";
import { createOperatorGate } from "../sim/operator.js";
import { OfficeRoom, type OfficeRoomOptions } from "./OfficeRoom.js";

const PASSPHRASE = "correct horse battery staple";
const REPO = "acme/office";
const AGENT = liveAgentKey(runnerSlotAgentId("box", "slot-1"));

/** An office with no operator passphrase, which trusts its CEO. */
const TRUSTING_ROOM = "office-trusting";

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
    slots: [{ id: "slot-1", name: "Claude 1", status: "working", issueNumber: 39, activity: "", pr: undefined }],
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
  const options = {
    liveAgents: link,
    runnerEvents: link,
    runnerCommands: link,
  } satisfies Partial<OfficeRoomOptions>;
  server.define(OFFICE_ROOM_NAME, OfficeRoom, { ...options, operatorGate: createOperatorGate(PASSPHRASE) });
  server.define(TRUSTING_ROOM, OfficeRoom, options);
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

async function openOffice(roomName = OFFICE_ROOM_NAME): Promise<{ dana: Tab; milo: Tab }> {
  const dana = listen(await new Client(endpoint).create<OfficeState>(roomName, { name: "Dana" }));
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

async function verified(tab: Tab): Promise<void> {
  tab.room.send(CLIENT_MESSAGE.operatorVerify, { passphrase: PASSPHRASE });
  await settled(() => {
    const occupant = tab.room.state.occupants?.get(tab.room.sessionId);
    return occupant !== undefined && isOperator(occupant);
  });
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
  it("refuses anyone but the CEO, and the CEO until verified, with the reason and nothing queued", async () => {
    const { dana, milo } = await openOffice();
    prompt(milo, "push to main");
    prompt(dana, "carry on");
    await settled(() => milo.rejections.length === 1 && dana.rejections.length === 1);
    expect(milo.rejections).toEqual([{ agentId: AGENT, rejection: AGENT_PROMPT_REJECTION.forbidden }]);
    expect(dana.rejections).toEqual([{ agentId: AGENT, rejection: AGENT_PROMPT_REJECTION.notOperator }]);
    expect(await commandsAfterAWhile()).toEqual([]);
  });

  it("types the operator-CEO's prompt once, and shows it in both tabs", async () => {
    const { dana, milo } = await openOffice();
    await verified(dana);
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
    await verified(dana);
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
    const { dana, milo } = await openOffice(TRUSTING_ROOM);
    prompt(dana, "hello", milo.room.sessionId);
    await settled(() => dana.rejections.length === 1);
    expect(dana.rejections).toEqual([{ agentId: milo.room.sessionId, rejection: AGENT_PROMPT_REJECTION.noAgent }]);
  });

  it("trusts the CEO where there is no operator passphrase, and rate-limits the prompts", async () => {
    const { dana } = await openOffice(TRUSTING_ROOM);
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
