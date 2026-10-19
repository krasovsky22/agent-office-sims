/**
 * The CEO editing a runner's coding agent's profile, against a real room over
 * real sockets and a real runner link, with the test playing the runner.
 *
 * What only a running room shows is the acceptance: every tab sees the
 * profile the runner reports; an edit from anyone but the CEO is refused to
 * its sender with the reason and never queued; the CEO's goes to the runner
 * once, sanitised, and changes the agent on the floor only once the runner
 * reports it back; an edit for an agent no runner keeps is refused; and edits
 * are rate-limited by the server.
 */

import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import {
  AGENT_PROFILE_BURST_ALLOWANCE,
  AGENT_PROFILE_REJECTION,
  type AgentProfile,
  type AgentProfileRejectedEvent,
  CLIENT_MESSAGE,
  DEFAULT_AGENT_DESCRIPTION,
  DEFAULT_AGENT_TITLE,
  OFFICE_ROOM_NAME,
  type OfficeState,
  type RunnerCommand,
  SERVER_MESSAGE,
  type ThrottledEvent,
  isLiveAgent,
  liveAgentKey,
} from "@sim/shared";
import { Client, type Room } from "colyseus.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { RunnerLink, runnerSlotAgentId } from "../agents/runnerLink.js";
import { OfficeRoom, type OfficeRoomOptions } from "./OfficeRoom.js";

const REPO = "acme/office";
const AGENT = liveAgentKey(runnerSlotAgentId("box", "slot-1"));
const DEFAULT: AgentProfile = { name: "Maya", title: DEFAULT_AGENT_TITLE, description: DEFAULT_AGENT_DESCRIPTION };

let server: Server;
let endpoint: string;
let link: RunnerLink;
/** What the runner reports of its one slot's agent. */
let reported: AgentProfile = DEFAULT;
const tabs: Tab[] = [];

/** One sync from the runner `box`, its one slot idle, answering with what it was sent. */
function runnerSync(acked: string[] = []): RunnerCommand[] {
  const outcome = link.sync({
    runnerId: "box",
    repo: REPO,
    acked,
    slots: [{ id: "slot-1", ...reported, status: "idle", issueNumber: undefined, activity: "", pr: undefined }],
    events: [],
  });
  return outcome.kind === "accepted" ? [...outcome.commands] : [];
}

/** Takes every command waiting for the runner, acking them so none comes again. */
function takeCommands(): RunnerCommand[] {
  const commands = runnerSync();
  runnerSync(commands.map((command) => command.id));
  return commands;
}

beforeAll(async () => {
  link = new RunnerLink({ repository: REPO, timeoutMs: 60_000 });
  runnerSync();
  server = new Server({ transport: new WebSocketTransport(), greet: false });
  server.define(OFFICE_ROOM_NAME, OfficeRoom, {
    liveAgents: link,
    runnerEvents: link,
    runnerCommands: link,
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
  reported = DEFAULT;
  runnerSync();
});

afterAll(async () => {
  link.stop();
  await server.gracefullyShutdown(false);
});

interface Tab {
  readonly room: Room<OfficeState>;
  readonly rejections: AgentProfileRejectedEvent[];
  readonly throttled: ThrottledEvent[];
}

function listen(room: Room<OfficeState>): Tab {
  const tab: Tab = { room, rejections: [], throttled: [] };
  room.onMessage("*", () => undefined);
  room.onMessage<AgentProfileRejectedEvent>(SERVER_MESSAGE.agentProfileRejected, (event) => {
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

/** The agent's profile as a tab sees it. */
function profileIn(tab: Tab): { name: string; title: string; description: string; profileEditable: boolean } | undefined {
  const agent = tab.room.state.occupants.get(AGENT);
  return agent === undefined || !isLiveAgent(agent)
    ? undefined
    : { name: agent.name, title: agent.title, description: agent.description, profileEditable: agent.profileEditable };
}

function edit(tab: Tab, profile: Record<string, unknown>, agentId = AGENT): void {
  tab.room.send(CLIENT_MESSAGE.agentProfile, { agentId, ...profile });
}

/** Lets the room handle what was just sent, then takes what reached the runner. */
async function commandsAfterAWhile(): Promise<RunnerCommand[]> {
  await new Promise((resolve) => setTimeout(resolve, 100));
  return takeCommands();
}

const GRACE = { name: "Grace", title: "Release Engineer", description: "Keeps the release branch green." };

describe("editing a coding agent's profile", () => {
  it("shows every tab the profile its runner reports, editable", async () => {
    const { dana, milo } = await openOffice();
    expect(profileIn(dana)).toEqual({ ...DEFAULT, profileEditable: true });
    expect(profileIn(milo)).toEqual(profileIn(dana));
  });

  it("refuses anyone but the CEO, with the reason and nothing queued", async () => {
    const { dana, milo } = await openOffice();
    edit(milo, GRACE);
    await settled(() => milo.rejections.length === 1);
    expect(milo.rejections).toEqual([{ agentId: AGENT, rejection: AGENT_PROFILE_REJECTION.forbidden }]);
    expect(dana.rejections).toEqual([]);
    expect(await commandsAfterAWhile()).toEqual([]);
  });

  it("queues the CEO's edit once, sanitised, and changes the agent once its runner reports it", async () => {
    const { dana, milo } = await openOffice();
    edit(dana, { name: " Grace\u0007 ", title: "Release   Engineer", description: "Keeps the release branch green.\r\n\r\n\r\nAlways." });
    const commands = await commandsAfterAWhile();
    expect(commands).toEqual([
      expect.objectContaining({
        slotId: "slot-1",
        kind: "profile",
        name: "Grace",
        title: "Release Engineer",
        description: "Keeps the release branch green.\n\nAlways.",
        requestedBy: "Dana",
      }),
    ]);
    expect(await commandsAfterAWhile()).toEqual([]);
    // Nothing changes on the floor until the runner says it has the profile.
    expect(profileIn(milo)?.name).toBe(DEFAULT.name);

    reported = { name: "Grace", title: "Release Engineer", description: "Keeps the release branch green.\n\nAlways." };
    runnerSync();
    await settled(() => profileIn(milo)?.name === "Grace" && profileIn(dana)?.name === "Grace");
    expect(profileIn(milo)).toEqual({ ...reported, profileEditable: true });
    expect(dana.rejections).toEqual([]);
  });

  it("refuses an edit for an agent no runner keeps, and drops one with no name or title", async () => {
    const { dana } = await openOffice();
    edit(dana, GRACE, liveAgentKey("someone-else"));
    await settled(() => dana.rejections.length === 1);
    expect(dana.rejections).toEqual([{ agentId: liveAgentKey("someone-else"), rejection: AGENT_PROFILE_REJECTION.noAgent }]);

    edit(dana, { ...GRACE, title: "   " });
    edit(dana, { ...GRACE, name: "\u0007" });
    edit(dana, { name: "Grace" });
    expect(await commandsAfterAWhile()).toEqual([]);
    expect(dana.rejections).toHaveLength(1);
  });

  it("rate-limits the CEO's edits", async () => {
    const { dana } = await openOffice();
    for (let index = 0; index <= AGENT_PROFILE_BURST_ALLOWANCE; index += 1) {
      edit(dana, { ...GRACE, title: `Release Engineer ${index}` });
    }
    await settled(() => dana.throttled.length === 1);
    expect(dana.throttled).toEqual([{ command: CLIENT_MESSAGE.agentProfile }]);
    expect(await commandsAfterAWhile()).toHaveLength(AGENT_PROFILE_BURST_ALLOWANCE);
  });
});
